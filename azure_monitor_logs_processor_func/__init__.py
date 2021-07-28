import os
from typing import List
import logging

import azure.functions as func

# The maximum size of the payload we can send to the Splunk HEC endpoint
SPLUNK_BATCH_MAX_SIZE_BYTES = 5 * 1024 * 1024

def main(events: List[func.EventHubEvent], failedEventsOutputBlob: func.Out[bytes]):
    """Entrypoint for function that handles a list of events.

    :param events: the events being processed
    :param failedEventsOutputBlob: the blob where failed to deliver events should be saved
    """

    hec_endpoint = os.environ.get("HecEndpoint")
    source_type = os.environ.get("SourceType")
    region = os.environ.get("Region")

    logging.info('Invoked with HecEndpoint=%s, SourceType=%s, Region=%s', hec_endpoint, source_type, region)

    """
    High level goals:
    * Validate input: HEC endpoint, region, eventhub name, and sourcetype
    * Convert each event to Splunk Event, set region, source and sourcetype
    * Build ceil(size(events)/SPLUNK_BATCH_MAX_SIZE_BYTES) batches of size SPLUNK_BATCH_MAX_SIZE_BYTES with 1 per line to send to Splunk
    * Send batches to splunk
    * if any batch fails, write to failedEventsOutputBlob
    """
    for event in events:
        failedEventsOutputBlob.set(event.get_body())
        logging.info('Python EventHub trigger processed an event: %s',
                     event.get_body().decode('utf-8'))
    return 1
