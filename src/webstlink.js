/* webstlink.js
 * STM32 / ST-Link debugger front-end
 *
 * Copyright Devan Lai 2017
 *
 * Ported from pystlink.py in the pystlink project,
 * Copyright Pavel Revak 2015
 *
 */

import * as libstlink from './lib/package.js';
import Mutex from './mutex.js';
import {
    hex_word as H32,
    hex_string
} from './lib/util.js';


const CPUID_REG = 0xe000ed00;

function H24(v) {
    return hex_string(v, 3);
}

export default class WebStlink {
    constructor(dbg = null) {
        this._stlink = null;
        this._driver = null;
        this._dbg = dbg;
        this._mcu = null;
        this._mutex = new Mutex;
        this._callbacks = {
            inspect: [],
            halted: [],
            resumed: [],
        };
    }

    add_callback(name, handler) {
        if (this._callbacks[name] === undefined) {
            throw new Error(`No callback event type named ${name}`);
        }

        if (!(handler instanceof Function)) {
            throw new Error("Callback handler must be callable");
        }

        this._callbacks[name].push(handler);
    }

    _dispatch_callback(name, ...args) {
        for (let callback of this._callbacks[name]) {
            callback.apply(undefined, args);
        }
    }

    async attach(device, device_dbg = null) {
        await this._mutex.lock();
        try {
            let connector = new libstlink.usb.Connector(device, device_dbg);
            let stlink = new libstlink.Stlinkv2(connector, this._dbg);
            try {
                await connector.connect();
                try {
                    await stlink.init();
                } catch (e) {
                    try {
                        await stlink.clean_exit();
                    } catch (exit_err) {
                        if (this._dbg) {
                            this._dbg.warning("Error while attempting to exit cleanly: " + exit_err);
                        }
                    } finally {
                        throw e;
                    }
                }
            } catch (e) {
                try {
                    await connector.disconnect();
                } catch (disconnect_err) {
                    if (this._dbg) {
                        this._dbg.warning("Error while attempting to disconnect: " + disconnect_err);
                    }
                } finally {
                    throw e;
                }
            }

            this._stlink = stlink;
            this._dbg.info("DEVICE: ST-Link/" + this._stlink.ver_str);
        } finally {
            this._mutex.unlock();
        }
    }

    async detach() {
        this._mutex.lock();
        try {
            if (this._stlink !== null) {
                try {
                    await this._stlink.clean_exit();
                } catch (exit_err) {
                    if (this._dbg) {
                        this._dbg.warning("Error while attempting to exit cleanly: " + exit_err);
                    }
                }

                if (this._stlink._connector !== null) {
                    try {
                        await this._stlink._connector.disconnect();
                    } catch (disconnect_err) {
                        if (this._dbg) {
                            this._dbg.warning("Error while attempting to disconnect: " + disconnect_err);
                        }
                    }
                }

                this._stlink = null;
            }
        } finally {
            this._mutex.unlock();
        }
    }

    get connected() {
        if (this._stlink !== null) {
            if (this._stlink._connector !== null) {
                // TODO:
                return true;
            }
        }
        return false;
    }

    async find_mcus_by_core() {
        let cpuid = await this._stlink.get_debugreg32(CPUID_REG);
        if (cpuid == 0) {
            throw new libstlink.exceptions.Exception("Not connected to CPU");
        }
        this._dbg.verbose("CPUID:  " + H32(cpuid));
        let partno = (0xfff & (cpuid >> 4));
        let mcus = libstlink.DEVICES.find(mcus => (mcus.part_no == partno));
        if (mcus) {
            this._mcus_by_core = mcus;
            return;
        }
        
        throw new libstlink.exceptions.Exception(`PART_NO: 0x${H24(partno)} is not supported`);
    }

    async find_mcus_by_devid() {
        let idcode = await this._stlink.get_debugreg32(this._mcus_by_core.idcode_reg);
        this._dbg.verbose("IDCODE: " + H32(idcode));
        let devid = (0xfff & idcode);
        let mcus = this._mcus_by_core.devices.find(mcus => (mcus.dev_id == devid));
        if (mcus) {
            this._mcus_by_devid = mcus;
            return;
        }
        throw new libstlink.exceptions.Exception(`DEV_ID: 0x${H24(devid)} is not supported`);
    }

    async find_mcus_by_flash_size() {
        this._flash_size = await this._stlink.get_debugreg16(this._mcus_by_devid.flash_size_reg);
        this._mcus = this._mcus_by_devid.devices.filter(
            mcu => (mcu.flash_size == this._flash_size)
        );
        if (this._mcus.length == 0) {
            throw new libstlink.exceptions.Exception(`Connected CPU with DEV_ID: 0x${H24(this._mcus_by_devid.dev_id)} and FLASH size: ${this._flash_size}KB is not supported`);
        }
    }

    fix_cpu_type(cpu_type) {
        cpu_type = cpu_type.toUpperCase();
        // now support only STM32
        if (cpu_type.startsWith("STM32")) {
            // change character on 10 position to 'x' where is package size code
            if (cpu_type.length > 9) {
                return cpu_type.substring(0, 10) + "x" + cpu_type.substring(11);
            }
            return cpu_type;
        }
        throw new libstlink.exceptions.Exception(`"${cpu_type}" is not STM32 family`);
    }

    filter_detected_cpu(expected_cpus) {
        let cpus = [];
        for (let detected_cpu of this._mcus) {
            for (let expected_cpu of expected_cpus) {
                expected_cpu = this.fix_cpu_type(expected_cpu);
                if (detected_cpu.type.startsWith(expected_cpu)) {
                    cpus.append(detected_cpu);
                    break;
                }
            }
        }

        if (cpus.length == 0) {
            let expected = expected_cpus.join(",");
            let possibilities = this._mcus.map(cpu => cpu.type).join(",");
            if (this._mcus.length > 1) {
                throw new libstlink.exceptions.Exception(`Connected CPU is not ${expected} but detected is one of ${possibilities}`);
            } else {
                throw new libstlink.exceptions.Exception(`Connected CPU is not ${expected} but detected is ${possibilities}`);
            }
        }
        this._mcus = cpus;
    }

    async find_sram_eeprom_size(pick_cpu = null) {
        // if is found more MCUS, then SRAM and EEPROM size
        // will be used the smallest of all (worst case)
        let sram_sizes = this._mcus.map(mcu => mcu.sram_size);
        let eeprom_sizes = this._mcus.map(mcu => mcu.eeprom_size);
        this._sram_size = Math.min.apply(null, sram_sizes);
        this._eeprom_size = Math.min.apply(null, eeprom_sizes);
        if (this._mcus.length > 1) {
            let diff = false;
            if (this._sram_size != Math.max.apply(null, sram_sizes)) {
                diff = true;
                if (pick_cpu === null) {
                    this._dbg.warning("Detected CPU family has multiple SRAM sizes");
                }
            }
            if (this._eeprom_size != Math.max.apply(null, eeprom_sizes)) {
                diff = true;
                if (pick_cpu === null) {
                    this._dbg.warning("Detected CPU family has multiple EEPROM sizes.");
                }
            }
            if (diff) {
                let mcu = null;
                if (pick_cpu) {
                    let type = await pick_cpu(this._mcus);
                    mcu = this._mcus.find(m => (m.type == type));
                }

                if (mcu) {
                    this._mcu = mcu;
                    this._sram_size = mcu.sram_size;
                    this._eeprom_size = mcu.eeprom_size;
                } else {
                    this._dbg.warning("Automatically choosing the MCU variant with the smallest flash and eeprom");
                    this._mcu = this._mcus.find(m => (m.sram_size == this._sram_size));
                }
            } else {
                this._mcu = this._mcus[0];
            }
        } else {
            this._mcu = this._mcus[0];
        }

        this._dbg.info(`SRAM:   ${this._sram_size}KB`);
        if (this._eeprom_size > 0) {
            this._dbg.info(`EEPROM: ${this._eeprom_size}KB`);
        }
    }

    load_driver() {
        let flash_driver = this._mcus_by_devid.flash_driver;
        if (flash_driver == "STM32FP") {
            this._driver = new libstlink.drivers.Stm32FP(this._stlink, this._dbg);
        } else if (flash_driver == "STM32FPXL") {
            this._driver = new libstlink.drivers.Stm32FPXL(this._stlink, this._dbg);
        } else if (flash_driver == "STM32FS") {
            this._driver = new libstlink.drivers.Stm32FS(this._stlink, this._dbg);
        } else {
            this._driver = new libstlink.drivers.Stm32(this._stlink, this._dbg);
        }
    }

    async detect_cpu(expected_cpus, pick_cpu = null) {
        this._dbg.info(`SUPPLY: ${this._stlink.target_voltage.toFixed(2)}V`);
        this._dbg.verbose("COREID: " + H32(this._stlink.coreid));
        if (this._stlink.coreid == 0) {
            throw new libstlink.exceptions.Exception("Not connected to CPU");
        }
        await this._mutex.lock();
        try {
            await this.find_mcus_by_core();
            this._dbg.info("CORE:   " + this._mcus_by_core.core);
            await this.find_mcus_by_devid();
            await this.find_mcus_by_flash_size();
            if (expected_cpus.count > 0) {
                // filter detected MCUs by selected MCU type
                this.filter_detected_cpu(expected_cpus);
            }
            this._dbg.info("MCU:    " + this._mcus.map(mcu => mcu.type).join("/"));
            this._dbg.info(`FLASH:  ${this._flash_size}KB`);
            await this.find_sram_eeprom_size(pick_cpu);
            this.load_driver();
            this._last_cpu_status = null;

            const info = {
                part_no: this._mcus_by_core.part_no,
                core: this._mcus_by_core.core,
                dev_id: this._mcus_by_devid.dev_id,
                type: this._mcu.type,
                flash_size: this._flash_size,
                sram_size: this._sram_size,
                flash_start: this._driver.FLASH_START,
                sram_start: this._driver.SRAM_START,
                eeprom_size: this._eeprom_size,
                freq: this._mcu.freq,
            };
            return info;
        } finally {
            this._mutex.unlock();
        }
    }

    async _unsafe_inspect_cpu(flush = false) {
        let dhcsr = await this._driver.core_status();
        let lockup = (dhcsr & libstlink.drivers.Stm32.DHCSR_STATUS_LOCKUP_BIT) != 0;
        if (lockup) {
            this._dbg.verbose("Clearing lockup");
            await this._driver.core_halt();
            dhcsr = await this._driver.core_status();
        }
        let status = {
            halted: (dhcsr & libstlink.drivers.Stm32.DHCSR_STATUS_HALT_BIT) != 0,
            debug:  (dhcsr & libstlink.drivers.Stm32.DHCSR_DEBUGEN_BIT) != 0,
        };

        let prev_status = this._last_cpu_status;
        if (flush) {
            prev_status = null;
        }

        this._last_cpu_status = status;

        this._dispatch_callback('inspect', status);

        if ((prev_status === null) || (prev_status.halted != status.halted)) {
            this._dispatch_callback(status.halted ? 'halted' : 'resumed');
        }
        
        return status;
    }

    async inspect_cpu() {
        await this._mutex.lock();
        try {
            return this._unsafe_inspect_cpu();
        } finally {
            this._mutex.unlock();
        }
    }

    get last_cpu_status() {
        return this._last_cpu_status;
    }

    async set_debug_enable(enabled) {
        await this._mutex.lock();
        try {
            if (enabled) {
                await this._driver.core_run();
            } else {
                await this._driver.core_nodebug();
            }
            await this._unsafe_inspect_cpu();
        } finally {
            this._mutex.unlock();
        }
    }

    async step() {
        await this._mutex.lock();
        try {
            await this._driver.core_step();
            await this._unsafe_inspect_cpu(true);
        } finally {
            this._mutex.unlock();
        }
    }

    async halt() {
        await this._mutex.lock();
        try {
            await this._driver.core_halt();
            await this._unsafe_inspect_cpu();
        } finally {
            this._mutex.unlock();
        }
    }

    async run() {
        await this._mutex.lock();
        try {
            await this._driver.core_run();
            await this._unsafe_inspect_cpu();
        } finally {
            this._mutex.unlock();
        }
    }

    async reset(halt) {
        await this._mutex.lock();
        try {
            if (halt) {
                await this._driver.core_halt();
            } else {
                await this._driver.core_reset();
            }
            await this._unsafe_inspect_cpu(true);
        } finally {
            this._mutex.unlock();
        }
    }

    async read_registers() {
        await this._mutex.lock();
        try {
            return await this._driver.get_reg_all();
        } finally {
            this._mutex.unlock();
        }
    }

    async read_memory(addr, size) {
        await this._mutex.lock();
        try {
            return await this._driver.get_mem(addr, size);
        } finally {
            this._mutex.unlock();
        }
    }

    async flash(addr, data) {
        if (data instanceof ArrayBuffer) {
            data = new Uint8Array(data);
        } else if (data instanceof DataView) {
            data = new Uint8Array(data.buffer);
        } else if (data instanceof Array) {
            let new_data = new Uint8Array(data.length);
            for (let i=0; i < data.length; i++) {
                if (typeof data[i] != "number" || data[i] < 0x00 || data[i] > 0xff) {
                    throw new libstlink.exceptions.Exception(`Datum at index ${i} is not a valid octet: ${data[i]}`);
                }
            }
            data = new_data;
        } else if (!(data instanceof Uint8Array)) {
            throw new libstlink.exceptions.Exception(`Data of type ${typeof data} is not supported`);
        }
        await this._mutex.lock();
        try {
            await this._driver.flash_write(addr, data, {
                erase: true,
                verify: true,
                erase_sizes: this._mcus_by_devid.erase_sizes
            });
            await this._unsafe_inspect_cpu(true);
        } finally {
            this._mutex.unlock();
        }
    }
}
