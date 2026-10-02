"""Minimal bounded WebSocket text transport over a local Unix socket (POC only)."""
import base64
import hashlib
import json
import os
import socket
import struct
import threading

LIMIT = 8 * 1024 * 1024


class UnixWebSocket:
    def __init__(self, path, timeout=12):
        self.socket = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.socket.settimeout(timeout)
        self.buffer = b""
        self.write_lock = threading.Lock()
        try:
            self.socket.connect(str(path))
            key = base64.b64encode(os.urandom(16)).decode()
            request = ("GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\n"
                       "Connection: Upgrade\r\nSec-WebSocket-Version: 13\r\n"
                       f"Sec-WebSocket-Key: {key}\r\n\r\n")
            self.socket.sendall(request.encode())
            while b"\r\n\r\n" not in self.buffer:
                data = self.socket.recv(4096)
                if not data:
                    raise ConnectionError("Socket closed before WebSocket upgrade")
                self.buffer += data
                if len(self.buffer) > 32768:
                    raise ConnectionError("WebSocket upgrade headers too large")
            header, self.buffer = self.buffer.split(b"\r\n\r\n", 1)
            lines = header.decode("latin-1").split("\r\n")
            if len(lines[0].split()) < 2 or lines[0].split()[1] != "101":
                raise ConnectionError("WebSocket upgrade refused: " + lines[0])
            headers = {name.strip().lower(): value.strip() for name, value in
                       (line.split(":", 1) for line in lines[1:] if ":" in line)}
            accept = base64.b64encode(hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest()).decode()
            if headers.get("sec-websocket-accept") != accept:
                raise ConnectionError("Invalid WebSocket accept value")
            if headers.get("upgrade", "").lower() != "websocket" or "upgrade" not in headers.get("connection", "").lower():
                raise ConnectionError("Invalid WebSocket upgrade headers")
            if headers.get("sec-websocket-extensions"):
                raise ConnectionError("Unexpected WebSocket extensions")
            self.socket.settimeout(None)
        except BaseException:
            self.socket.close()
            raise

    def _exact(self, length):
        while len(self.buffer) < length:
            data = self.socket.recv(min(65536, length - len(self.buffer)))
            if not data:
                raise EOFError("WebSocket connection closed")
            self.buffer += data
        value, self.buffer = self.buffer[:length], self.buffer[length:]
        return value

    def _send(self, opcode, payload):
        if len(payload) > LIMIT:
            raise ValueError("WebSocket message exceeds POC size limit")
        mask = os.urandom(4)
        head = bytes([0x80 | opcode])
        length = len(payload)
        if length < 126:
            head += bytes([0x80 | length])
        elif length <= 65535:
            head += bytes([0x80 | 126]) + struct.pack("!H", length)
        else:
            head += bytes([0x80 | 127]) + struct.pack("!Q", length)
        body = bytes(value ^ mask[index % 4] for index, value in enumerate(payload))
        with self.write_lock:
            self.socket.sendall(head + mask + body)

    def send(self, value):
        self._send(1, json.dumps(value).encode())

    def receive(self):
        fragments = bytearray()
        assembling = False
        while True:
            first, second = self._exact(2)
            final, opcode = bool(first & 0x80), first & 15
            if first & 0x70 or second & 0x80:
                raise ValueError("Unexpected WebSocket flags or masked server frame")
            length = second & 127
            if length == 126:
                length = struct.unpack("!H", self._exact(2))[0]
            elif length == 127:
                length = struct.unpack("!Q", self._exact(8))[0]
            if length > LIMIT or len(fragments) + length > LIMIT:
                raise ValueError("WebSocket response exceeds 8 MiB POC limit")
            if opcode >= 8 and (not final or length > 125):
                raise ValueError("Invalid WebSocket control frame")
            payload = self._exact(length)
            if opcode == 8:
                raise EOFError("Server closed the WebSocket")
            if opcode == 9:
                self._send(10, payload)
                continue
            if opcode == 10:
                continue
            if opcode == 1 and not assembling:
                assembling = True
            elif opcode != 0 or not assembling:
                raise ValueError("Unexpected WebSocket data frame")
            fragments.extend(payload)
            if final:
                return json.loads(fragments.decode())

    def close(self):
        try:
            self.socket.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        self.socket.close()
