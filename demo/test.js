import * as libstlink from '../src/lib/package.js';
import WebStlink from '../src/webstlink.js';
import { hex_octet, hex_word, hex_octet_array } from '../src/lib/util.js';
import cs from './capstone-arm.min.js';

function fetchResource(url) {
    return new Promise(function(resolve, reject) {
        let xhr = new XMLHttpRequest();
        xhr.responseType = "arraybuffer";
        xhr.addEventListener("load", function() {
            if (this.status != 200) {
                reject(this.status);
            } else {
                resolve(this.response);
            }
        });
        xhr.addEventListener("error", function() {
            reject(this.status);
        });
        xhr.open("GET", url);
        xhr.send();
    });
}

function read_file_as_array_buffer(file) {
    return new Promise(function (resolve, reject) {
        let reader = new FileReader();
        reader.onload = function() {
            resolve(reader.result);
        };
        reader.onerror = function() {
            reject(reader.error);
        };
        reader.readAsArrayBuffer(file);
    });
}

function show_error_dialog(error) {
    let dialog = document.createElement("dialog");
    let header = document.createElement("h1");
    header.textContent = "Uh oh! Something went wrong.";
    let contents = document.createElement("p");
    contents.textContent = error.toString();
    let button = document.createElement("button");
    button.textContent = "Close";

    button.addEventListener("click", (evt) => {
        dialog.close();
    });

    dialog.addEventListener("close", (evt) => {
        dialog.remove();
    });

    dialog.appendChild(header);
    dialog.appendChild(contents);
    dialog.appendChild(document.createElement("br"));
    dialog.appendChild(button);

    document.querySelector("body").appendChild(dialog);

    dialog.showModal();
}

async function pick_sram_variant(mcu_list) {
    // Display a dialog with the MCU variants for the user to pick
    let dialog = document.querySelector("#mcuDialog");
    let tbody = dialog.querySelector("tbody");

    // Remove old entries
    for (let row of tbody.querySelectorAll("tr")) {
        tbody.removeChild(row);
    }

    const columns = [
        ["type", ""],
        ["freq", "MHz"],
        ["flash_size", "KiB"],
        ["sram_size", "KiB"],
        ["eeprom_size", "KiB"],
    ];

    for (let mcu of mcu_list) {
        let tr = document.createElement("tr");
        for (let [key, suffix] of columns) {
            let td = document.createElement("td");
            if (key == "type") {
                let label = document.createElement("label");
                let input = document.createElement("input");
                let text = document.createTextNode(mcu[key] + suffix);

                label.appendChild(input);
                label.appendChild(text);
                input.type = "radio";
                input.name = "mcuIndex";
                input.value = mcu.type;
                input.required = true;

                td.appendChild(label);
            } else {
                td.textContent = mcu[key] + suffix;
            }
            tr.appendChild(td);
        }
        tbody.appendChild(tr);
    }

    let submit_promise = new Promise(function (resolve, reject) {
        function on_submit(evt) {
            dialog.removeEventListener('cancel', on_cancel);
            resolve(evt.target.elements["mcuIndex"].value);
        }

        function on_cancel() {
            dialog.removeEventListener('submit', on_submit);
            reject();
        }

        dialog.addEventListener('cancel', on_cancel, { once: true});
        dialog.addEventListener('submit', on_submit, { once: true});
    });

    dialog.showModal();

    // Wait for the user's selection and return it, otherwise
    // return null if they canceled
    try {
        let type = await submit_promise;
        return type;
    } catch (e) {
        return null;
    }
}

function update_registers(registers, explicit = false) {
    for (let [name, value] of Object.entries(registers)) {
        let span = document.getElementById(name);
        let text = (name + ":").padEnd(5);
        text += "0x" + value.toString(16).padStart(8,"0");
        text += value.toString().padStart(12);

        if (text != span.textContent && !span.textContent.endsWith("-")) {
            span.classList.add("register-updated");
        } else {
            span.classList.remove("register-updated");
        }
        
        span.textContent = text;
    }

    if (explicit) {
        let registerDetails = document.getElementById("registerDisplay");
        registerDetails.open = true;
    }
}

function reset_registers() {
    for (let span of document.querySelectorAll("span.register")) {
        let name = span.id;
        let text = (name + ":").padEnd(5);
        text += "-".repeat(10) + "-".padStart(12);
        span.classList.remove("register-updated");
        span.textContent = text;
    }
}

function update_debugger_info(stlink, device) {
    let probeInfo = document.getElementById("probeInfo");
    let summary = probeInfo.querySelector("summary");
    let version = "ST-Link/" + stlink._stlink.ver_str;
    summary.textContent = `Debugger - ${version} - Connected`;
    document.getElementById("productName").textContent = device.productName;
    document.getElementById("mfgName").textContent = device.manufacturerName;
    document.getElementById("serialNumber").textContent = device.serialNumber;
}

function update_target_status(status, target = null) {
    let targetInfo = document.getElementById("targetInfo");
    let targetStatus = document.getElementById("targetStatus");

    if (target !== null) {
        let targetType = document.getElementById("targetType");
        targetType.textContent = "- " + target.type + " -";

        // Remove old target fields
        for (let div of targetInfo.querySelectorAll("div")) {
            targetInfo.removeChild(div);
        }
        
        let fields = [
            ["type",        "Type", ""],
            ["core",        "Core", ""],
            ["dev_id",      "Device ID", ""],
            ["flash_size",  "Flash Size", "KiB"],
            ["sram_size",   "SRAM Size", "KiB"],
        ];
        if (target.eeprom_size > 0) {
            fields.push(["eeprom_size", "EEPROM Size", "KiB"]);
        }
        for (let [key, title, suffix] of fields) {
            let div = document.createElement("div");
            div.textContent = title + ": " + target[key] + suffix;
            targetInfo.appendChild(div);
        }
    }

    let haltState = status.halted ? "Halted" : "Running";
    let debugState = "Debugging " + (status.debug ? "Enabled" : "Disabled");

    targetStatus.textContent = `${haltState}, ${debugState}`;
}

function prevent_submission(event) {
    event.preventDefault();
    return false;
}

document.addEventListener('DOMContentLoaded', event => {
    var stlink = null;
    var curr_device = null;

    let log = document.querySelector("#log");
    let logger = new libstlink.Logger(1, log);

    document.querySelector("#logLevel").addEventListener('change', function(evt) {
        logger.set_verbose(evt.target.value);
        let desc = evt.target.nextSibling.textContent;
        if (desc.indexOf("-") != -1) {
            desc = desc.substring(0, desc.indexOf("-"));
        }

        this.querySelector("summary").textContent = "Logging Level - " + desc;
    });

    let pollingForm = document.getElementById("pollingForm");
    let polling_mode = "on";
    let polling_interval = 200;

    async function poll_cpu() {
        let summary = document.getElementById("pollingDisplay").querySelector("summary");

        if (polling_mode == "off") {
            summary.textContent = "Polling - off";
        } else if (stlink !== null && stlink.connected && stlink.examined) {
            let active = false;
            let running = false;
            let debuggable = false;
            if (polling_mode == "always") {
                summary.textContent = "Polling - active";
                let status = await stlink.inspect_cpu();
                running = !status.halted;
                debuggable = status.debug;
                active = true;
            } else if (polling_mode == "on") {
                let status = stlink.last_cpu_status;
                if (status === null || !status.halted) {
                    status = await stlink.inspect_cpu();
                }
                debuggable = status.debug;
                if (!status.halted) {
                    running = true;
                    active = true;
                }
            }

            if (active) {
                summary.textContent = "Polling - active";
                if (running && debuggable) {
                    if (document.getElementById("pollRegisters").checked) {
                        let registers = await stlink.read_registers();
                        update_registers(registers);
                    }
                    if (document.getElementById("pollMemory").checked) {
                        await read_and_display_memory(false);
                    }
                }
            } else {
                summary.textContent = "Polling - idle";
            }
        } else {
            summary.textContent = "Polling - disconnected";
        }
    }

    let polling_id = null;
    function setup_polling(mode, interval) {
        if (polling_id !== null) {
            clearInterval(polling_id);
            polling_id = null;
        }

        if (polling_mode != "off") {
            polling_id = setInterval(poll_cpu, polling_interval);
        }
    }

    pollingForm.addEventListener("change", async function (evt) {
        let prev_mode = polling_mode;
        let prev_interval = polling_interval;
        polling_mode = pollingForm.elements["mode"].value;
        polling_interval = parseInt(pollingForm.elements["interval"].value);
        if ((prev_mode != polling_mode) || (prev_interval != polling_interval)) {
            if (polling_mode == "off") {
                let summary = document.getElementById("pollingDisplay").querySelector("summary");
                summary.textContent = "Polling - off";
            } else {
                await poll_cpu();
            }
            setup_polling(polling_mode, polling_interval);
        }
    });

    pollingForm.addEventListener("submit", prevent_submission);

    setup_polling(polling_mode, polling_interval);

    let connectButton = document.querySelector("#connect");
    let runHaltButton = document.querySelector("#runHalt");
    let stepButton = document.querySelector("#step");
    let resetButton = document.querySelector("#reset");
    let readRegistersButton = document.querySelector("#readRegisters");
    let readMemoryButton = document.querySelector("#readMemory");
    let flashButton = document.querySelector("#flash");

    runHaltButton.addEventListener('click', async function() {
        if (stlink !== null && stlink.connected) {
            if (stlink.last_cpu_status.halted) {
                await stlink.run();
            } else {
                await stlink.halt();
            }
        }
    });

    stepButton.addEventListener('click', async function() {
        if (stlink !== null && stlink.connected) {
            await stlink.step();
        }
    });

    resetButton.addEventListener('click', async function() {
        if (stlink !== null) {
            await stlink.reset(stlink.last_cpu_status.halted);
        }
    });

    readRegistersButton.addEventListener('click', async function(evt) {
        if (stlink !== null && stlink.connected) {
            let registers = await stlink.read_registers();
            update_registers(registers, true);
        }
    });

    async function read_and_display_memory(explicit = false) {
        if (stlink !== null && stlink.connected) {
            let addr_field = document.getElementById("memoryReadAddress");
            let size_field = document.getElementById("memoryReadSize");
            try {
                var addr = parseInt(addr_field.value, 16);
                var size = parseInt(size_field.value, 10);
            } catch (error) {
                return;
            }
            let memory = await stlink.read_memory(addr, size);
            let memoryContents = document.getElementById("memoryContents");
            memoryContents.textContent = hex_octet_array(memory).join(" ");
            if (explicit) {
                let memoryDetails = document.getElementById("memoryDisplay");
                memoryDetails.open = true;
            }
        }
    }

    const mode = cs.MODE_THUMB + cs.MODE_MCLASS
               + cs.MODE_LITTLE_ENDIAN;
    let decoder = new cs.Capstone(cs.ARCH_ARM, mode);
    async function disassemble_current_instruction() {
        if (stlink !== null && stlink.connected) {
            let pc = await stlink.read_register("PC");
            const window_size = document.getElementById("disasmWindowSize").value;
            const addr = (pc & 0xfffffffe);
            const start_addr = addr - 2 * window_size;
            const end_addr = addr + 2 + 2 * window_size;
            let inst_bytes = await stlink.read_memory(start_addr, (end_addr - start_addr + 1));
            let disasm = "";
            try {
                let instructions = decoder.disasm(inst_bytes, start_addr);
                let lines = [];
                for (let inst of instructions) {
                    let line = hex_word(inst.address);
                    if (inst.address == (pc & 0xfffffffe)) {
                        line += "  → ";
                    } else {
                        line += "    ";
                    }
                    line += inst.mnemonic.padEnd(8);
                    line += inst.op_str;
                    lines.push(line);
                }
                disasm = lines.join("\n");
            } catch (err) {
                logger.error(`Failed to decode instructions [${hex_word(start_addr)}-${hex_word(end_addr)}]`)
            }
            let disp = document.getElementById("assemblyContents");
            disp.textContent = disasm;
            disp.rows = 1 + (2 * window_size);
        }
    }

    readMemoryButton.addEventListener('click', function (evt) {
        return read_and_display_memory(true);
    });

    flashButton.addEventListener('click', async function (evt) {
        if (stlink !== null && stlink.connected) {
            let addr_field = document.getElementById("flashWriteAddress");
            try {
                var addr = parseInt(addr_field.value, 16);
            } catch (error) {
                return;
            }

            let field = document.getElementById("flashBinaryFile");
            if (field.files.length > 0) {
                let file = field.files[0];
                let data = await read_file_as_array_buffer(file);
                try {
                    await stlink.flash(addr, data);
                } catch (err) {
                    logger.error(err);
                    show_error_dialog(err);
                }
            }
        }
    });

    function update_capabilities(status) {
        if (status.debug) {
            if (status.halted) {
                runHaltButton.textContent = "Run";
                readRegistersButton.disabled = false;
                readMemoryButton.disabled = false;
                stepButton.disabled = false;
                flashButton.disabled = false;
            } else {
                runHaltButton.textContent = "Halt";
                readRegistersButton.disabled = true;
                readMemoryButton.disabled = true;
                stepButton.disabled = true;
                flashButton.disabled = true;
            }
            runHaltButton.disabled = false;
            resetButton.disabled = false;
        } else {
            runHaltButton.disabled = true;
            resetButton.disabled = true;
            stepButton.disabled = true;
            readRegistersButton.disabled = true;
            readMemoryButton.disabled = true;
            flashButton.disabled = true;
        }
    }

    let semihostingEnabled = document.getElementById("semihostingEnabled");
    semihostingEnabled.addEventListener("change", function (evt) {
        let summary = document.getElementById("semihostingDisplay").querySelector("summary");
        summary.textContent = "Semihosting - " + (semihostingEnabled.checked ? "enabled" : "off");
    });

    let semihostingOutput = document.getElementById("semihostingOutput");
    async function handle_semihosting() {
        let handled = await stlink.handle_semihosting(oper => {
            const opcodes = libstlink.semihosting.opcodes;
            if (oper.opcode == opcodes.SYS_OPEN) {
                // TODO: keep track of file handles
                return 1;
            } else if (oper.opcode == opcodes.SYS_WRITE) {
                let msg = String.fromCharCode.apply(undefined, oper.data);
                semihostingOutput.textContent += msg;
                return 0;
            } else if (oper.opcode == opcodes.SYS_FLEN) {
                return 0;
            } else if (oper.opcode == opcodes.SYS_ERRNO) {
                return 0;
            } else if (oper.opcode == opcodes.SYS_ISTTY) {
                // TODO: keep track of file handles
                return 1;
            } else {
                return -1;
            }
        });

        return handled;
    }

    async function on_successful_attach(stlink, device) {
        // Export for manual debugging
        window.stlink = stlink;
        window.device = device;

        // Reset settings
        connectButton.textContent = "Disconnect";
        reset_registers();

        // Populate debugger info
        update_debugger_info(stlink, device);

        // Add disconnect handler
        navigator.usb.addEventListener('disconnect', function (evt) {
            if (evt.device === device) {
                navigator.usb.removeEventListener('disconnect', this);
                if (device === curr_device) {
                    on_disconnect();
                }
            }
        });

        // Detect attached target CPU
        let target = await stlink.detect_cpu([], pick_sram_variant);

        // Attach the semihosting handler
        stlink.add_callback('halted', async () => {
            if (semihostingEnabled.checked) {
                let semihosted = await handle_semihosting();
                if (semihosted && !stlink.last_cpu_status.halted) {
                    // Skip updating the UI when handling semihosting
                    return false;
                }
            }
        });

        // Attach UI callbacks for whenever the CPU state is inspected
        function update_on_inspection(status) {
            // Update display
            update_target_status(status, null);
            // Update buttons
            update_capabilities(status);
        }

        stlink.add_callback('halted', update_on_inspection);
        stlink.add_callback('resumed', update_on_inspection);

        // Handle auto-read-on-halt functionality
        stlink.add_callback('halted', async () => {
            if (document.getElementById("autoReadRegisters").checked) {
                let registers = await stlink.read_registers();
                update_registers(registers);
            }
            if (document.getElementById("autoReadMemory").checked) {
                await read_and_display_memory(false);
            }
            await disassemble_current_instruction();
        });

        // Update the UI with detected target info and debug state
        let status = await stlink.inspect_cpu();
        if (!status.debug) {
            // Automatically enable debugging
            await stlink.set_debug_enable(true);
            status = await stlink.inspect_cpu();
        }

        update_target_status(status, target);
        update_capabilities(status);

        // Set the read memory address to the SRAM start
        document.getElementById("memoryReadAddress").value = "0x" + hex_word(target.sram_start);

        // Set the flash write address to the Flash start
        document.getElementById("flashWriteAddress").value = "0x" + hex_word(target.flash_start);
    }

    function on_disconnect() {
        logger.info("Device disconnected");
        connectButton.textContent = "Connect";

        readRegistersButton.disabled = true;
        readMemoryButton.disabled = true;
        runHaltButton.disabled = true;
        stepButton.disabled = true;
        resetButton.disabled = true;
        flashButton.disabled = true;

        let probeInfo = document.getElementById("probeInfo");
        let summary = probeInfo.querySelector("summary");
        summary.textContent = "Debugger - Disconnected";

        let pollingForm = document.getElementById("pollingForm");
        let pollingInfo = document.getElementById("pollingDisplay");
        summary = pollingInfo.querySelector("summary");
        summary.textContent = "Polling - Idle";

        document.getElementById("productName").textContent = "";
        document.getElementById("mfgName").textContent = "";
        document.getElementById("serialNumber").textContent = "";
        
        stlink = null;
        curr_device = null;
    }

    if (typeof navigator.usb === 'undefined') {
        logger.error("WebUSB is either disabled or not available in this browser");
        connectButton.disabled = true;
    }
    
    connectButton.addEventListener('click', async function() {
        if (stlink !== null) {
            await stlink.detach();
            on_disconnect();
            return;
        }

        try {
            let device = await navigator.usb.requestDevice({
                filters: libstlink.usb.filters
            });
            logger.clear();
            let next_stlink = new WebStlink(logger);
            await next_stlink.attach(device, logger);
            stlink = next_stlink;
            curr_device = device;
        } catch (err) {
            logger.error(err);
        }

        if (stlink !== null) {
            await on_successful_attach(stlink, curr_device);
        }
    });
});
