#!/usr/bin/env python3
"""RC522 and media-button event source for SubLim3 Nexus Core."""

import json
import os
import signal
import sys
import threading
import time

from gpiozero import Button, OutputDevice
import spidev


RUNNING = True


def emit(event):
    print(json.dumps(event, separators=(",", ":")), flush=True)


class RC522:
    IDLE = 0x00
    CALC_CRC = 0x03
    TRANSCEIVE = 0x0C
    SOFT_RESET = 0x0F
    PICC_REQUEST = 0x52
    CASCADE_LEVELS = (0x93, 0x95, 0x97)

    COMMAND = 0x01
    COM_IRQ = 0x04
    DIV_IRQ = 0x05
    ERROR = 0x06
    FIFO_DATA = 0x09
    FIFO_LEVEL = 0x0A
    CONTROL = 0x0C
    BIT_FRAMING = 0x0D
    COLL = 0x0E
    MODE = 0x11
    TX_CONTROL = 0x14
    TX_ASK = 0x15
    T_MODE = 0x2A
    T_PRESCALER = 0x2B
    T_RELOAD_H = 0x2C
    T_RELOAD_L = 0x2D

    def __init__(self, bus=0, device=0, reset_gpio=25):
        self.spi = spidev.SpiDev()
        self.spi.open(bus, device)
        self.spi.max_speed_hz = 1_000_000
        self.spi.mode = 0
        self.reset = OutputDevice(reset_gpio, active_high=True, initial_value=True)
        self.reset.off()
        time.sleep(0.05)
        self.reset.on()
        time.sleep(0.05)
        self.write(self.COMMAND, self.SOFT_RESET)
        time.sleep(0.05)
        self.write(self.T_MODE, 0x8D)
        self.write(self.T_PRESCALER, 0x3E)
        self.write(self.T_RELOAD_L, 30)
        self.write(self.T_RELOAD_H, 0)
        self.write(self.TX_ASK, 0x40)
        self.write(self.MODE, 0x3D)
        self.set_bits(self.TX_CONTROL, 0x03)

    def write(self, register, value):
        self.spi.xfer2([((register << 1) & 0x7E), value & 0xFF])

    def read(self, register):
        return self.spi.xfer2([((register << 1) & 0x7E) | 0x80, 0])[1]

    def set_bits(self, register, mask):
        self.write(register, self.read(register) | mask)

    def clear_bits(self, register, mask):
        self.write(register, self.read(register) & (~mask))

    def communicate(self, data):
        self.write(self.COMMAND, self.IDLE)
        self.write(self.COM_IRQ, 0x7F)
        self.set_bits(self.FIFO_LEVEL, 0x80)
        for value in data:
            self.write(self.FIFO_DATA, value)
        self.write(self.COMMAND, self.TRANSCEIVE)
        self.set_bits(self.BIT_FRAMING, 0x80)
        deadline = time.monotonic() + 0.04
        irq = 0
        while time.monotonic() < deadline:
            irq = self.read(self.COM_IRQ)
            if irq & 0x30 or irq & 0x01:
                break
        self.clear_bits(self.BIT_FRAMING, 0x80)
        if irq & 0x01 or self.read(self.ERROR) & 0x1B:
            return [], 0
        count = min(self.read(self.FIFO_LEVEL), 64)
        last_bits = self.read(self.CONTROL) & 0x07
        bits = (count - 1) * 8 + last_bits if count and last_bits else count * 8
        return [self.read(self.FIFO_DATA) for _ in range(count)], bits

    def crc(self, data):
        self.write(self.COMMAND, self.IDLE)
        self.write(self.DIV_IRQ, 0x04)
        self.set_bits(self.FIFO_LEVEL, 0x80)
        for value in data:
            self.write(self.FIFO_DATA, value)
        self.write(self.COMMAND, self.CALC_CRC)
        deadline = time.monotonic() + 0.04
        while time.monotonic() < deadline and not self.read(self.DIV_IRQ) & 0x04:
            pass
        return [self.read(0x22), self.read(0x21)]

    def select(self, level, block):
        frame = [level, 0x70] + block
        response, bits = self.communicate(frame + self.crc(frame))
        return response[0] if bits == 0x18 and response else None

    def halt(self):
        frame = [0x50, 0x00]
        self.communicate(frame + self.crc(frame))

    def uid(self):
        self.write(self.BIT_FRAMING, 0x07)
        response, bits = self.communicate([self.PICC_REQUEST])
        if bits != 0x10 or len(response) != 2:
            return None
        uid = []
        for level in self.CASCADE_LEVELS:
            self.write(self.BIT_FRAMING, 0)
            self.clear_bits(self.COLL, 0x80)
            block, block_bits = self.communicate([level, 0x20])
            if block_bits != 40 or len(block) != 5 or (block[0] ^ block[1] ^ block[2] ^ block[3]) != block[4]:
                return None
            sak = self.select(level, block)
            if sak is None:
                return None
            uid.extend(block[1:4] if block[0] == 0x88 else block[:4])
            if not sak & 0x04:
                value = "".join(f"{byte:02x}" for byte in uid)
                self.halt()
                return value
        return None

    def close(self):
        self.spi.close()
        self.reset.close()


def gpio(name, default):
    return int(os.environ.get(name, default))


def stop(_signal, _frame):
    global RUNNING
    RUNNING = False


def main():
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    buttons = []
    for name, pin in (("volume_down", gpio("NEXUS_BUTTON_DOWN_GPIO", 15)), ("volume_up", gpio("NEXUS_BUTTON_UP_GPIO", 5))):
        if pin < 0:
            continue
        try:
            button = Button(pin, pull_up=True, bounce_time=0.03)
            button.when_pressed = lambda key=name: emit({"type": "button", "name": key, "pressed": True})
            button.when_released = lambda key=name: emit({"type": "button", "name": key, "pressed": False})
            buttons.append(button)
        except Exception as error:
            print(f"Button {name} on GPIO{pin} disabled: {error}", file=sys.stderr, flush=True)

    reader = RC522(gpio("NEXUS_RFID_SPI_BUS", 0), gpio("NEXUS_RFID_SPI_DEVICE", 0), gpio("NEXUS_RFID_RESET_GPIO", 25))
    current = None
    misses = 0
    try:
        while RUNNING:
            uid = reader.uid()
            if uid:
                misses = 0
                if uid != current:
                    if current:
                        emit({"type": "rfid", "uid": current, "present": False})
                    current = uid
                    emit({"type": "rfid", "uid": uid, "present": True})
            elif current:
                misses += 1
                if misses >= 3:
                    emit({"type": "rfid", "uid": current, "present": False})
                    current = None
                    misses = 0
            time.sleep(0.08)
    finally:
        reader.close()
        for button in buttons:
            button.close()


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(str(error), file=sys.stderr, flush=True)
        raise
