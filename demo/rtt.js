import { hex_octet, hex_word, hex_octet_array } from '../src/lib/util.js';

class RTTBuffer {
    constructor(addr, name, data_ptr, size, write_offset, read_offset, flags) {
        this.addr = addr;
        this.name = name;
        this.data_ptr = data_ptr;
        this.size = size;
        this.write_offset = write_offset;
        this.read_offset = read_offset;
        this.flags = flags;
    }

    async read_status(webstlink) {
        let buffer = this;
        await webstlink.perform_with_mutex(async function() {
            let mem = await this._driver.get_mem(buffer.addr, 24);
            let view = new DataView(mem.buffer);
            buffer.write_offset = view.getUint32(12, true);
            buffer.read_offset = view.getUint32(16, true);
            buffer.flags = view.getUint32(20, true);
        });
    }

    async read_data(webstlink) {
        let buffer = this;
        return await webstlink.perform_with_mutex(async function() {
            let ctrl_mem = await this._driver.get_mem(buffer.addr, 24);
            let view = new DataView(ctrl_mem.buffer);
            buffer.write_offset = view.getUint32(12, true);
            buffer.read_offset = view.getUint32(16, true);
            buffer.flags = view.getUint32(20, true);

            if (buffer.write_offset == buffer.read_offset) {
                return null;
            } else if (buffer.write_offset > buffer.read_offset) {
                let avail = (buffer.write_offset - buffer.read_offset);
                let ptr = buffer.data_ptr + buffer.read_offset;
                let data_mem = await this._driver.get_mem(ptr, avail);
                buffer.read_offset = buffer.write_offset;
                await this._driver.set_mem(buffer.addr + 16, buffer.read_offset);
                return data_mem;
            } else {
                let avail = buffer.size - (buffer.read_offset - buffer.write_offset - 1);

                let data;
                let ptr1 = buffer.data_ptr + buffer.read_offset;
                let data_mem1 = await this._driver.get_mem(ptr1, buffer.size - buffer.read_offset);
                if (buffer.write_offset > 0) {
                    let ptr2 = buffer.data_ptr;
                    let data_mem2 = await this._driver.get_mem(ptr2, buffer.write_offset - 1);
                    data = new UInt8Array(avail);
                    data.set(data_mem1);
                    data.set(data_mem2, data_mem1.length);
                } else {
                    data = data_mem1;
                }
                buffer.read_offset = buffer.write_offset;
                await this._driver.set_mem(buffer.addr + 16, buffer.read_offset);
                return data;
            }            
        });
    }
}

async function find_rtt_control_block(webstlink, control_string) {
    return await webstlink.perform_with_mutex(async function() {
        let base_addr = this._driver.SRAM_START;
        let memory = await this._driver.get_mem(base_addr, this._sram_size * 1024);
        let str = String.fromCharCode.apply(undefined, memory);
        let control_block_offset = str.indexOf(control_string);
        if (control_block_offset == -1) {
            this._dbg.info("Failed to locate RTT control block");
            return null;
        }

        let control_block_addr = base_addr + control_block_offset;
        this._dbg.info(`Found RTT control block at ${hex_word(control_block_addr)}`);

        let control_block_view = new DataView(memory.buffer, control_block_offset, 1024);
        let max_num_up_buffers = control_block_view.getInt32(16, true);
        let max_num_down_buffers = control_block_view.getInt32(20, true);
        this._dbg.info(`Max up: ${max_num_up_buffers}; Max down: ${max_num_down_buffers}`);

        let buffer_offset = 24;
        let up_buffers = [];
        let down_buffers = [];
        for (let i=0; i < (max_num_up_buffers + max_num_down_buffers); i++) {
            let buffer_addr = control_block_addr + buffer_offset;
            let data_ptr = control_block_view.getUint32(buffer_offset + 4, true);
            let buf_size = control_block_view.getUint32(buffer_offset + 8, true);
            let write_offset = control_block_view.getUint32(buffer_offset + 12, true);
            let read_offset = control_block_view.getUint32(buffer_offset + 16, true);
            let flags = control_block_view.getUint32(buffer_offset + 20, true);

            const is_up_buffer = (i < max_num_up_buffers);
            const buffer_type = is_up_buffer ? "Up" : "Down"
            if (data_ptr != 0) {
                let buffer = new RTTBuffer(buffer_addr, "", data_ptr, buf_size, write_offset, read_offset, flags);
                if (is_up_buffer) {
                    up_buffers.push(buffer);
                } else {
                    down_buffers.push(buffer);
                }
                this._dbg.info(`${buffer_type} buffer ${i} ctrl @ 0x${hex_word(buffer_addr)}; (${buf_size} bytes) @ 0x${hex_word(data_ptr)}`);
            }
            buffer_offset += 24;
        }

        return {
            "address": control_block_addr,
            "max_num_up_buffers": max_num_up_buffers,
            "max_num_down_buffers": max_num_down_buffers,
            "up_buffers": up_buffers,
            "down_buffers": down_buffers,
        };
    });

}

export {
    find_rtt_control_block,
};
