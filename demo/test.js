import * as libstlink from '../src/lib/package.js';
import WebStlink from '../src/webstlink.js'
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

document.addEventListener('DOMContentLoaded', event => {
    let connectButton = document.querySelector("#connect");
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

    connectButton.addEventListener('click', function() {
        navigator.usb.requestDevice({ filters: libstlink.usb.filters }).then(
            async device => {
                curr_device = device;
                logger.clear();
                let stlink = new WebStlink(logger)
                try {
                    await stlink.attach_stlink(device, logger);
                    window.stlink = stlink;
                    window.probe = stlink._stlink;
                    await stlink.detect_cpu([]);
                } catch (err) {
                    logger.error(err);
                }
            },
            err => {
                logger.clear();
                logger.error(err);
            }
        );
    });
});
