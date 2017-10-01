/* util.js
 * Common helper functions
 *
 * Copyright Devan Lai 2017
 *
 * Ported from lib/stlinkusb.py in the pystlink project,
 * Copyright Pavel Revak 2015
 *
 */
function hex_octet(b) {
    return ("00" + b.toString(16)).slice(-2);
}

function hex_halfword(hw) {
    return ("0000" + hw.toString(16)).slice(-4);
}

function hex_word(w) {
    return ("00000000" + w.toString(16)).slice(-8);
}

function hex_octet_array(arr) {
    return Array.from(arr, hex_octet);
}

export {
    hex_octet,
    hex_halfword,
    hex_word,
    hex_octet_array
};
