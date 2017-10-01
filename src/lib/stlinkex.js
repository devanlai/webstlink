/* stlinkex.js
 * ST-Link exception classes
 *
 * Copyright Devan Lai 2017
 *
 * Ported from lib/stlinkex.py in the pystlink project,
 * Copyright Pavel Revak 2015
 *
 */

import { hex_octet } from './util.js';

const Exception = class StlinkException extends Error {};
const Warning = class StlinkWarning extends Error {};

const UsbError = class StlinkUsbError extends Error {
    constructor(message, address) {
        super(message);
        this.address = address;
    }

    toString() {
        if (this.address) {
            const addr_string = "0x" + hex_octet(this.address);
            return addr_string + ": " + this.message;
        } else {
            return this.message;
        }
    }
};

export { Exception, Warning, UsbError };
