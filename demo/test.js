import * as libstlink from '../src/lib/package.js';
import WebStlink from '../src/webstlink.js'

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

    let index = 0;
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

function update_registers(registers) {
    for (let [name, value] of registers) {
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
    let summary = targetInfo.querySelector("summary");

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
    
    let connectButton = document.querySelector("#connect");
    
    let readRegistersButton = document.querySelector("#readRegisters");
    let runHaltButton = document.querySelector("#runHalt");
    let stepButton = document.querySelector("#step");
    let resetButton = document.querySelector("#reset");
    let debugButton = document.querySelector("#debug");

    debugButton.addEventListener('click', async function() {
        if (debugButton.textContent.includes("Enable")) {
            await stlink._driver.core_run();
        } else {
            await stlink._driver.core_nodebug();
        }
        await stlink.get_cpu_status();
    });
    
    runHaltButton.addEventListener('click', async function() {
        if (stlink !== null) {
            if (stlink.last_cpu_status.halted) {
                await stlink._driver.core_run();
            } else {
                await stlink._driver.core_halt();
            }
            await stlink.get_cpu_status();
        }
    });

    stepButton.addEventListener('click', async function() {
        if (stlink !== null) {
            await stlink._driver.core_step();
            await stlink.get_cpu_status();
        }
    });

    resetButton.addEventListener('click', async function() {
        if (stlink !== null) {
            if (stlink.last_cpu_status.halted) {
                await stlink._driver.core_reset_halt();
            } else {
                await stlink._driver.core_reset();
            }
            await stlink.get_cpu_status();
        }
    });
    
    document.querySelector("#logLevel").addEventListener('change', function(evt) {
        logger.set_verbose(evt.target.value);
        let desc = evt.target.nextSibling.textContent;
        if (desc.indexOf("-") != -1) {
            desc = desc.substring(0, desc.indexOf("-"));
        }

        this.querySelector("summary").textContent = "Logging Level - " + desc;
    });

    
    readRegistersButton.addEventListener('click', async function(evt) {
        if (stlink !== null) {            
            let registers = await stlink._driver.get_reg_all();
            update_registers(registers);
        }
    });

    function update_capabilities(status) {
        if (status.debug) {
            debugButton.textContent = "Disable debugging";
            if (status.halted) {
                runHaltButton.textContent = "Run";
                readRegistersButton.disabled = false;
                stepButton.disabled = false;
            } else {
                runHaltButton.textContent = "Halt";
                readRegistersButton.disabled = true;
                stepButton.disabled = true;
            }
            runHaltButton.disabled = false;
            resetButton.disabled = false;
        } else {
            debugButton.textContent = "Enable debugging";
            runHaltButton.disabled = true;
            resetButton.disabled = true;
            stepButton.disabled = true;
            readRegistersButton.disabled = true;
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

        // Populate target info
        let status = await stlink.get_cpu_status();
        update_target_status(status, target);

        // Update available capabilities
        update_capabilities(status);

        // Attach the status callback for future updates
        stlink.set_cpu_status_callback(status => {
            // Update display
            update_target_status(status, target);
            // Update buttons
            update_capabilities(status);
        });
    }

    function on_disconnect() {
        logger.info("Device disconnected");
        connectButton.textContent = "Connect";
        debugButton.disabled = true;

        readRegistersButton.disabled = true;
        runHaltButton.disabled = true;
        stepButton.disabled = true;
        resetButton.disabled = true;

        let probeInfo = document.getElementById("probeInfo");
        let summary = document.querySelector("summary");
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
            let next_stlink = new WebStlink(logger)
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
