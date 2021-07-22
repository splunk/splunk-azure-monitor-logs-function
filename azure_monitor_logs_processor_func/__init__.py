from typing import List
import logging

import azure.functions as func


def main(events: List[func.EventHubEvent], failed_events_output_blob: func.Out[bytes]):
    """Entrypoint for function that handles a list of events.

    :param events: the events being processed
    :param failed_events_output_blob: the blob where failed to deliver events should be saved
    """
    for event in events:
        failed_events_output_blob.set(event.get_body())
        logging.info('Python EventHub trigger processed an event: %s',
                     event.get_body().decode('utf-8'))
    return 1
