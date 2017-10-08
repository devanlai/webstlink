import * as libstlink from '../src/lib/package.js';
import WebStlink from '../src/webstlink.js';
import { hex_word, hex_octet_array } from '../src/lib/util.js';

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
    
    let connectButton = document.querySelector("#connect");
    let runHaltButton = document.querySelector("#runHalt");
    let stepButton = document.querySelector("#step");
    let resetButton = document.querySelector("#reset");
    let debugButton = document.querySelector("#debug");
    let readRegistersButton = document.querySelector("#readRegisters");
    let readMemoryButton = document.querySelector("#readMemory");
    let flashButton = document.querySelector("#flash");

    debugButton.addEventListener('click', async function() {
        const enable = debugButton.textContent.includes("Enable");
        if (stlink !== null && stlink.connected) {
            await stlink.set_debug_enable(enable);
        }
    });
    
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

    readMemoryButton.addEventListener('click', function (evt) {
        return read_and_display_memory(true);
    });

    flashButton.addEventListener('click', async function (evt) {
        if (stlink !== null && stlink.connected) {
            let addr_field = document.getElementById("memoryReadAddress");
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
            debugButton.textContent = "Disable debugging";
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
            debugButton.textContent = "Enable debugging";
            runHaltButton.disabled = true;
            resetButton.disabled = true;
            stepButton.disabled = true;
            readRegistersButton.disabled = true;
            readMemoryButton.disabled = true;
            flashButton.disabled = true;
        }
    }

    async function on_successful_attach(stlink, device) {
        // Export for manual debugging
        window.stlink = stlink;
        window.device = device;

        // Reset settings
        connectButton.textContent = "Disconnect";
        debugButton.disabled = false;
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

        // Attach UI callbacks for whenever the CPU state is inspected
        stlink.add_callback('inspect', status => {
            // Update display
            update_target_status(status, null);
            // Update buttons
            update_capabilities(status);
        });

        stlink.add_callback('halted', async () => {
            if (document.getElementById("autoReadRegisters").checked) {
                let registers = await stlink.read_registers();
                update_registers(registers);
            }
            if (document.getElementById("autoReadMemory").checked) {
                await read_and_display_memory(false);
            }
        });

        // Update the UI with detected target info and debug state
        let status = await stlink.inspect_cpu();
        update_target_status(status, target);

        // Set the read memory address to the SRAM start
        document.getElementById("memoryReadAddress").value = "0x" + hex_word(target.sram_start);

        // Set the flash write address to the Flash start
        document.getElementById("flashWriteAddress").value = "0x" + hex_word(target.flash_start);
    }

    function on_disconnect() {
        logger.info("Device disconnected");
        connectButton.textContent = "Connect";
        debugButton.disabled = true;

        readRegistersButton.disabled = true;
        readMemoryButton.disabled = true;
        runHaltButton.disabled = true;
        stepButton.disabled = true;
        resetButton.disabled = true;
        flashButton.disabled = true;

        let probeInfo = document.getElementById("probeInfo");
        let summary = probeInfo.querySelector("summary");
        summary.textContent = `Debugger - Disconnected`;

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
