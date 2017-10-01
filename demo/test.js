import * as libstlink from '../src/lib/package.js';
var curr_device;
var probe;

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

class Debugger {
    constructor(container) {
        this.container = container;
    }

    debug(msg) {
        console.log(msg);
        let info = document.createElement("div");
        info.className = "info";
        info.textContent = msg;
        this.container.appendChild(info);
    }
}

document.addEventListener('DOMContentLoaded', event => {
    let connectButton = document.querySelector("#connect");
    let log = document.querySelector("#log");
    connectButton.addEventListener('click', function() {
        navigator.usb.requestDevice({ filters: libstlink.usb.filters }).then(
            async device => {
                curr_device = device;
                let debuggr = new Debugger(log);
                let connector = new libstlink.usb.Connector(device, debuggr);
                probe = new libstlink.Stlinkv2(connector, debuggr);
                await device.open();
                await device.selectConfiguration(1);
                await device.claimInterface(0);
                await device.selectAlternateInterface(0, 0);
                try {
                    await probe.init();
                } catch (e) {
                    console.log(e);
                }
            }
        );
    });
});
