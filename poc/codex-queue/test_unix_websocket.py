"""Offline protocol regression tests for the local WebSocket transport."""
import base64
import hashlib
import json
import queue
import socket
import struct
import threading
import unittest
from unittest.mock import patch

import exercise
import unix_websocket
from unix_websocket import LIMIT, UnixWebSocket


def server_frame(opcode, payload=b"", final=True, rsv=0, masked=False):
    first = (0x80 if final else 0) | rsv | opcode
    second = (0x80 if masked else 0) | len(payload)
    return bytes((first, second)) + payload


class HandshakeTests(unittest.TestCase):
    def connect_with_reply(self, accept_transform=lambda value: value):
        client_sock, peer_sock = socket.socketpair()
        captured = {}

        class ConnectedSocket:
            def __init__(self, sock):
                self.sock = sock

            def connect(self, _path):
                # socketpair already models the post-connect Unix stream.
                pass

            def __getattr__(self, name):
                return getattr(self.sock, name)

        def peer():
            request = bytearray()
            while b"\r\n\r\n" not in request:
                request.extend(peer_sock.recv(4096))
            key = next(line.split(b":", 1)[1].strip().decode()
                       for line in request.split(b"\r\n") if line.lower().startswith(b"sec-websocket-key:"))
            expected = base64.b64encode(hashlib.sha1(
                (key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest()).decode()
            captured["request"] = bytes(request)
            reply = ("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n"
                     "Connection: keep-alive, Upgrade\r\nSec-WebSocket-Accept: "
                     + accept_transform(expected) + "\r\n\r\n").encode()
            peer_sock.sendall(reply)
            peer_sock.close()

        thread = threading.Thread(target=peer, daemon=True)
        thread.start()
        return ConnectedSocket(client_sock), thread, captured

    def test_handshake_accept_validates_accept_and_upgrade(self):
        sock, thread, captured = self.connect_with_reply()
        with patch.object(unix_websocket.socket, "socket", return_value=sock):
            ws = UnixWebSocket("mock.sock")
        self.assertIn(b"Upgrade: websocket", captured["request"])
        ws.close()
        thread.join(1)

    def test_handshake_rejects_wrong_accept(self):
        sock, thread, _ = self.connect_with_reply(lambda _: "wrong")
        with patch.object(unix_websocket.socket, "socket", return_value=sock):
            with self.assertRaisesRegex(ConnectionError, "Invalid WebSocket accept"):
                UnixWebSocket("mock.sock")
        thread.join(1)


class FrameTests(unittest.TestCase):
    class CaptureSocket:
        def __init__(self, incoming=b""):
            self.incoming = bytearray(incoming)
            self.sent = []

        def sendall(self, data):
            self.sent.append(data)

        def recv(self, length):
            data = bytes(self.incoming[:length])
            del self.incoming[:length]
            return data

    def setUp(self):
        self.ws = UnixWebSocket.__new__(UnixWebSocket)
        self.ws.socket = self.CaptureSocket()
        self.ws.buffer = b""
        self.ws.write_lock = threading.Lock()

    def decode_client_frame(self, frame):
        first, second = frame[:2]
        self.assertTrue(second & 0x80, "client frames must be masked")
        length_code = second & 0x7f
        offset = 2
        if length_code == 126:
            length = struct.unpack("!H", frame[offset:offset + 2])[0]
            offset += 2
        elif length_code == 127:
            length = struct.unpack("!Q", frame[offset:offset + 8])[0]
            offset += 8
        else:
            length = length_code
        mask = frame[offset:offset + 4]
        payload = frame[offset + 4:]
        self.assertEqual(len(payload), length)
        return first & 15, bytes(byte ^ mask[i % 4] for i, byte in enumerate(payload))

    def test_client_masks_payload_and_encodes_short_extended_and_64bit_lengths(self):
        payloads = [b"short", b"x" * 126, b"y" * 65536]
        for payload in payloads:
            self.ws._send(1, payload)
            opcode, decoded = self.decode_client_frame(self.ws.socket.sent[-1])
            self.assertEqual((opcode, decoded), (1, payload))

    def test_fragmented_json_with_interleaved_ping_sends_pong(self):
        self.ws.socket.incoming = bytearray(
            server_frame(1, b'{"id":', final=False)
            + server_frame(9, b"ping")
            + server_frame(0, b"7}", final=True)
        )
        self.assertEqual(self.ws.receive(), {"id": 7})
        self.assertEqual(self.decode_client_frame(self.ws.socket.sent[0]), (10, b"ping"))

    def test_malformed_and_oversized_frames_are_rejected(self):
        bad_frames = [
            server_frame(1, b"{}", rsv=0x40),
            server_frame(1, b"{}", masked=True),
            server_frame(0, b"{}"),  # continuation without an open message
            server_frame(2, b"binary"),
            bytes((0x89, 126)) + struct.pack("!H", 126) + b"x" * 126,  # oversized ping
            bytes((0x81, 127)) + struct.pack("!Q", LIMIT + 1),
        ]
        for frame in bad_frames:
            with self.subTest(frame=frame[:4]):
                self.ws.socket = self.CaptureSocket(frame)
                with self.assertRaises((ValueError, EOFError)):
                    self.ws.receive()


class ClientTests(unittest.TestCase):
    def test_client_initialize_round_trip_over_transport(self):
        class FakeTransport:
            def __init__(self, path):
                self.inbox = queue.Queue()
                self.sent = []
                self.closed = False

            def send(self, frame):
                self.sent.append(frame)
                if frame.get("method") == "initialize":
                    self.inbox.put({"id": frame["id"], "result": {"protocolVersion": "mock"}})

            def receive(self):
                try:
                    return self.inbox.get(timeout=1)
                except queue.Empty:
                    raise EOFError("mock transport closed")

            def close(self):
                self.closed = True

        with patch.object(exercise, "UnixWebSocket", FakeTransport):
            client = exercise.Client("socket")
            try:
                result = client.call("initialize", {"clientInfo": {"name": "test", "version": "1"}})
                self.assertEqual(result, {"protocolVersion": "mock"})
                self.assertEqual(client.transport.sent[0]["method"], "initialize")
            finally:
                client.close()
            self.assertTrue(client.transport.closed)


if __name__ == "__main__":
    unittest.main()
