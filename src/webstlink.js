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
        this._start_time = Date.now();
        this._stlink = null;
        this._driver = null;
        this._dbg = dbg;
    }

    async attach_stlink(device, device_dbg = null) {
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

    find_sram_eeprom_size() {
        // if is found more MCUS, then SRAM and EEPROM size
        // will be used the smallest of all (worst case)
        let sram_sizes = this._mcus.map(mcu => mcu.sram_size);
        let eeprom_sizes = this._mcus.map(mcu => mcu.eeprom_size);
        this._sram_size = Math.min.apply(null, sram_sizes);
        this._eeprom_size = Math.min.apply(null, eeprom_sizes);
        this._dbg.info(`SRAM:   ${this._sram_size}KB`)
        if (this._eeprom_size > 0) {
            this._dbg.info(`EEPROM: ${this._eeprom_size}KB`);
        }
        if (this._mcus.length > 1) {
            let diff = false;
            if (this._sram_size != Math.max.apply(null, sram_sizes)) {
                diff = true;
                this._dbg.warning("Detected CPUs have different SRAM sizes.");
            }
            if (this._eeprom_size != Math.max.apply(null, eeprom_sizes)) {
                diff = true;
                this._dbg.warning("Detected CPUs have different EEPROM sizes.");
            }
            if (diff) {
                this._dbg.warning("Is recommended to select certain CPU with --cpu {cputype}. Now is used the smallest memory size.");
            }
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

    async detect_cpu(expected_cpus) {
        this._dbg.info(`SUPPLY: ${this._stlink.target_voltage.toFixed(2)}V`);
        this._dbg.verbose("COREID: " + H32(this._stlink.coreid));
        if (this._stlink.coreid == 0) {
            throw new libstlink.exceptions.Exception("Not connected to CPU");
        }
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
        this.find_sram_eeprom_size();
        this.load_driver();
    }

    print_buffer(addr, data, bytes_per_line = 16) {
        var chunk, prev_chunk, same_chunk;
        prev_chunk = [];
        same_chunk = false;
        for (var i = 0, _pj_a = data.length; (i < _pj_a); i += bytes_per_line) {
            chunk = data.slice(i, (i + bytes_per_line));
            if ((prev_chunk !== chunk)) {
                console.log(("%08x  %s%s  %s" % [addr, " ".join(function () {
    var _pj_b = [], _pj_c = chunk;
    for (var _pj_d = 0, _pj_e = _pj_c.length; (_pj_d < _pj_e); _pj_d += 1) {
        var d = _pj_c[_pj_d];
        _pj_b.push(("%02x" % d));
    }
    return _pj_b;
}
.call(this)), ("   " * (16 - chunk.length)), "".join(function () {
    var _pj_f = [], _pj_g = chunk;
    for (var _pj_h = 0, _pj_i = _pj_g.length; (_pj_h < _pj_i); _pj_h += 1) {
        var d = _pj_g[_pj_h];
        _pj_f.push((((d >= 32) && (d < 127)) ? chr(d) : "."));
    }
    return _pj_f;
}
.call(this))]));
                prev_chunk = chunk;
                same_chunk = false;
            } else {
                if ((! same_chunk)) {
                    console.log("*");
                    same_chunk = true;
                }
            }
            addr += chunk.length;
        }
        console.log(H32(addr));
    }

    async dump_mem(addr, size) {
        console.log(`${H32(addr)}, ${size}`);
        let data = await this._driver.get_mem(addr, size);
        this.print_buffer(addr, data);
    }

    async cmd_dump(params) {
        let cmd = params[0];
        params.slice(1);
        if (cmd == "core") {
            // dump all core registers
            await this._driver.core_halt();
            let registers = await this._driver.get_reg_all();
            for (let [reg, val] of registers) {
                console.log(`  ${reg.padStart(3)}: ${H32(val)}`);
            }
        } else if (this._driver.is_reg(cmd)) {
            // dump core register
            this._driver.core_halt();
            let reg = cmd.toUpperCase();
            let val = await this._driver.get_reg(reg);
            console.log(`  ${reg.padStart(3)}: ${H32(val)}`);
        } else if (cmd === "flash") {
            let size = (params ? Number.parseInt(params[0], 0) : (this._flash_size * 1024));
            let data = await this._driver.get_mem(this._driver.FLASH_START, size);
            this.print_buffer(this._driver.FLASH_START, data);
        } else if (cmd === "sram") {
            let size = (params ? Number.parseInt(params[0], 0) : (this._sram_size * 1024));
            let data = await this._driver.get_mem(this._driver.SRAM_START, size);
            this.print_buffer(this._driver.SRAM_START, data);
        } else if (params) {
            // dump memory from address with size
            let addr = Number.parseInt(cmd, 0);
            let data = await this._driver.get_mem(addr, Number.parseInt(params[0], 0));
            this.print_buffer(addr, data);
        } else {
            // dump 32 bit register at address
            let addr = Number.parseInt(cmd, 0);
            let val = await this._stlink.get_debugreg32(addr);
            console.log(`  ${H32(addr)}: ${H32(val)}`);
        }
    }

    cmd_read(params) {
        var addr, cmd, data, file_name, size;
        cmd = params[0];
        file_name = params.slice((- 1))[0];
        params = params.slice(1, (- 1));
        if ((cmd === "flash")) {
            addr = this._driver.FLASH_START;
            size = (params ? Number.parseInt(params[0], 0) : (this._flash_size * 1024));
        } else {
            if ((cmd === "sram")) {
                addr = this._driver.SRAM_START;
                size = (params ? Number.parseInt(params[0], 0) : (this._sram_size * 1024));
            } else {
                if (params) {
                    addr = Number.parseInt(cmd, 0);
                    size = Number.parseInt(params[0], 0);
                } else {
                    throw new libstlink.exceptions.ExceptionBadParam();
                }
            }
        }
        data = this._driver.get_mem(addr, size);
        this.store_file(addr, data, file_name);
    }
    cmd_set(params) {
        var addr, cmd, data, reg;
        cmd = params[0];
        params = params.slice(1);
        if ((! params)) {
            throw new libstlink.exceptions.ExceptionBadParam("Missing argument");
        }
        data = Number.parseInt(params[0], 0);
        if (this._driver.is_reg(cmd)) {
            this._driver.core_halt();
            reg = cmd.toUpperCase();
            this._driver.set_reg(reg, data);
        } else {
            addr = Number.parseInt(cmd, 0);
            this._stlink.set_debugreg32(addr, data);
        }
    }
    cmd_fill(params) {
        var cmd, size, value;
        cmd = params[0];
        value = Number.parseInt(params.slice((- 1))[0], 0);
        params = params.slice(1, (- 1));
        if ((cmd === "sram")) {
            size = (params ? Number.parseInt(params[0], 0) : (this._sram_size * 1024));
            this._driver.fill_mem(this._driver.SRAM_START, size, value);
        } else {
            if (params) {
                this._driver.fill_mem(Number.parseInt(cmd, 0), Number.parseInt(params[0], 0), value);
            } else {
                throw new libstlink.exceptions.ExceptionBadParam();
            }
        }
    }
    cmd_write(params) {
        var addr, data, mem;
        mem = this.read_file(params.slice((- 1))[0]);
        params = params.slice(0, (- 1));
        if (((mem.length === 1) && (mem[0][0] === null))) {
            data = mem[0][1];
            if ((params.length !== 1)) {
                throw new libstlink.exceptions.ExceptionBadParam("Address is not set");
            }
            if ((params[0] === "sram")) {
                addr = this._driver.SRAM_START;
                if ((data.length > (this._sram_size * 1024))) {
                    throw new libstlink.exceptions.ExceptionBadParam("Data are bigger than SRAM");
                }
            } else {
                addr = Number.parseInt(params[0], 0);
            }
            this._driver.set_mem(addr, data);
            return;
        }
        if (params) {
            throw new libstlink.exceptions.Exception("Address for write is set by file");
        }
        for (var destructure_addr_data, _pj_c = 0, _pj_a = mem, _pj_b = _pj_a.length; (_pj_c < _pj_b); _pj_c += 1) {
            destructure_addr_data = _pj_a[_pj_c];
            this._driver.set_mem(addr, data);
        }
    }
    cmd_flash(params) {
        var addr, erase, mem, start_addr, verify;
        erase = false;
        if ((params[0] === "erase")) {
            params = params.slice(1);
            if ((! params)) {
                this._driver.flash_erase_all();
                return;
            }
            erase = true;
        }
        mem = this.read_file(params.slice((- 1))[0]);
        params = params.slice(0, (- 1));
        verify = false;
        if ((params && (params[0] === "verify"))) {
            verify = true;
            params = params.slice(1);
        }
        start_addr = lib.stm32.Stm32.FLASH_START;
        if (((mem.length === 1) && (mem[0][0] === null))) {
            if (params) {
                start_addr = Number.parseInt(params[0], 0);
                params = params.slice(1);
            }
        }
        if (params) {
            throw new libstlink.exceptions.ExceptionBadParam("Address for write is set by file");
        }
        for (var destruct_addr_data, _pj_c = 0, _pj_a = mem, _pj_b = _pj_a.length; (_pj_c < _pj_b); _pj_c += 1) {
            destruct_addr_data = _pj_a[_pj_c];
            if ((addr === null)) {
                addr = start_addr;
            }
            this._driver.flash_write(addr, data, {"erase": erase, "verify": verify, "erase_sizes": this._mcus_by_devid["erase_sizes"]});
        }
    }
    async cmd(param) {
        var addr, cmd, params, reg;
        cmd = param[0];
        params = param.slice(1);
        if (((cmd === "dump") && params)) {
            await this.cmd_dump(params);
        } else {
            if (((cmd === "dump16") && params)) {
                addr = Number.parseInt(params[0], 0);
                reg = await this._stlink.get_debugreg16(addr);
                console.log(("  %08x: %04x" % [addr, reg]));
            } else {
                if (((cmd === "dump8") && params)) {
                    addr = Number.parseInt(params[0], 0);
                    reg = this._stlink.get_debugreg8(addr);
                    console.log(("  %08x: %02x" % [addr, reg]));
                } else {
                    if (((cmd === "read") && params)) {
                        this.cmd_read(params);
                    } else {
                        if (((cmd === "set") && params)) {
                            this.cmd_set(params);
                        } else {
                            if (((cmd === "write") && params)) {
                                this.cmd_write(params);
                            } else {
                                if (((cmd === "fill") && params)) {
                                    this.cmd_fill(params);
                                } else {
                                    if (((cmd === "flash") && params)) {
                                        this.cmd_flash(params);
                                    } else {
                                        if ((cmd === "reset")) {
                                            if (params) {
                                                if ((params[0] === "halt")) {
                                                    this._driver.core_reset_halt();
                                                } else {
                                                    throw new libstlink.exceptions.ExceptionBadParam();
                                                }
                                            } else {
                                                this._driver.core_reset();
                                            }
                                        } else {
                                            if ((cmd === "halt")) {
                                                this._driver.core_halt();
                                            } else {
                                                if ((cmd === "step")) {
                                                    this._driver.core_step();
                                                } else {
                                                    if ((cmd === "run")) {
                                                        this._driver.core_run();
                                                    } else {
                                                        if (((cmd === "sleep") && (params.length === 1))) {
                                                            time.sleep(Number.parseFloat(params[0]));
                                                        } else {
                                                            throw new libstlink.exceptions.ExceptionBadParam();
                                                        }
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    start() {
        var args, group_actions, group_verbose, parser, runtime_status;
        parser = new argparse.ArgumentParser({"prog": "pystlink", "formatter_class": argparse.RawTextHelpFormatter, "description": DESCRIPTION_STR, "epilog": ACTIONS_HELP_STR});
        group_verbose = parser.add_argument_group({"title": "set verbosity level"}).add_mutually_exclusive_group();
        group_verbose.set_defaults({"verbosity": 1});
        group_verbose.add_argument("-q", "--quiet", {"action": "store_const", "dest": "verbosity", "const": 0});
        group_verbose.add_argument("-i", "--info", {"action": "store_const", "dest": "verbosity", "const": 1, "help": "default"});
        group_verbose.add_argument("-v", "--verbose", {"action": "store_const", "dest": "verbosity", "const": 2});
        group_verbose.add_argument("-d", "--debug", {"action": "store_const", "dest": "verbosity", "const": 3});
        parser.add_argument("-V", "--version", {"action": "version", "version": VERSION_STR});
        parser.add_argument("-c", "--cpu", {"action": "append", "help": "set expected CPU type [eg: STM32F051, STM32L4]"});
        parser.add_argument("-r", "--no-run", {"action": "store_true", "help": "do not run core when program end (if core was halted)"});
        parser.add_argument("-u", "--no-unmount", {"action": "store_true", "help": "do not unmount DISCOVERY from ST-Link/V2-1 on OS/X platform"});
        group_actions = parser.add_argument_group({"title": "actions"});
        group_actions.add_argument("action", {"nargs": "*", "help": "actions will be processed sequentially"});
        args = parser.parse_args();
        this._dbg = new lib.dbg.Dbg(args.verbosity);
        runtime_status = 0;
        try {
            this.detect_cpu(args.cpu, (! args.no_unmount));
            if ((args.action && (this._driver === null))) {
                throw new libstlink.exceptions.ExceptionCpuNotSelected();
            }
            for (var action, _pj_c = 0, _pj_a = args.action, _pj_b = _pj_a.length; (_pj_c < _pj_b); _pj_c += 1) {
                action = _pj_a[_pj_c];
                this._dbg.verbose(("CMD: %s" % action));
                try {
                    this.cmd(action.split(":"));
                } catch(e) {
                    if ((e instanceof ExceptionBadParam)) {
                        throw e.set_cmd(action);
                    } else {
                        throw e;
                    }
                }
            }
        } catch(e) {
            if (((e instanceof ExceptionBadParam) || (e instanceof Exception))) {
                this._dbg.error(e);
                runtime_status = 1;
            } else {
                if ((e instanceof KeyboardInterrupt)) {
                    this._dbg.error("Keyboard interrupt");
                    runtime_status = 1;
                } else {
                    if (((e instanceof ValueError) || (e instanceof OverflowError) || (e instanceof FileNotFoundError) || (e instanceof Exception))) {
                        this._dbg.error(("Parameter error: %s" % e));
                        if ((args.verbosity >= 3)) {
                            throw e;
                        }
                        runtime_status = 1;
                    } else {
                        throw e;
                    }
                }
            }
        }
        if (this._stlink) {
            try {
                if (this._driver) {
                    if ((! args.no_run)) {
                        this._driver.core_nodebug();
                    } else {
                        this._dbg.warning("CPU may stay in halt mode", {"level": 1});
                    }
                }
                this._stlink.leave_state();
                this._stlink.clean_exit();
            } catch(e) {
                if ((e instanceof Exception)) {
                    this._dbg.error(e);
                    runtime_status = 1;
                } else {
                    throw e;
                }
            }
            this._dbg.verbose(("DONE in %0.2fs" % (time.time() - this._start_time)));
        }
        if (runtime_status) {
            sys.exit(runtime_status);
        }
    }
};
