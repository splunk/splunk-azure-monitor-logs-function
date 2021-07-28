import unittest

import azure.functions as func
from azure_monitor_logs_processor_func.echo import echo
from azure_monitor_logs_processor_func import main


class TestHello(unittest.TestCase):
    def test_echo(self):
        msg = 'hello'
        self.assertEqual(echo(msg), msg)

    def test_azure_monitor_logs_processor_func(self):
        # Construct a mock HTTP request.
        events = [func.EventHubEvent(body=str.encode('{"hello":"world"}'))]

        # Call the function and check the output.
        # We'd want to do something more fancy though.
        self.assertEqual(
            main(events, DoNothingOut()),
            1,
        )


class DoNothingOut(func.Out):
    def set(self, val: bytes) -> None:
        pass

    def get(self) -> bytes:
        pass
