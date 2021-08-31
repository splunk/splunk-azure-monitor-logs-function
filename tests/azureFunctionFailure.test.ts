import axios from 'axios';
import { expect } from 'chai';
import { SinonStub } from 'sinon';

import azureMonitorLogsProcessorFunc from '../azure_monitor_logs_processor_func/index';
import { context, mockEnv, sandbox } from './common';

const splunkContext: any = context;

describe('Azure Monitor Logs Process', function () {
  describe('Failed Events', () => {
    let httpClientStub: SinonStub;
    let postStub: SinonStub;

    this.beforeEach(() => {
      httpClientStub = sandbox.stub(axios, 'create');
      postStub = sandbox.stub();
      sandbox.stub(process, 'env').value(mockEnv);
      splunkContext.bindings = {};
    });

    this.afterEach(() => {
      sandbox.restore();
    });

    it('should save events on global exception', async () => {
      httpClientStub.throws('Error');

      const eventHubMessages = [{
        records: [
          {
            'Foo': 'from_msg1',
          },
          {
            'Foo': 'from_msg2',
          }
        ]
      }];

      await azureMonitorLogsProcessorFunc(splunkContext, eventHubMessages);

      expect(splunkContext.bindings).to.include.keys('failedParseEventsOutputBlob');
      expect(splunkContext.bindings).to.not.include.keys('failedSendEventsOutputBlob');
      expect(splunkContext.bindings.failedParseEventsOutputBlob).to.equal(eventHubMessages);
    });

    it('should save multiple events on global exception', async () => {
      httpClientStub.throws('Error');
      const eventHubMessages = [
        {
          records: [
            {
              'Foo': 'event1_from_msg1',
            },
            {
              'Foo': 'event1_from_msg2',
            }
          ]
        },
        {
          records: [
            {
              'Foo': 'event2_from_msg1',
            }
          ]
        }
      ];

      await azureMonitorLogsProcessorFunc(splunkContext, eventHubMessages);

      expect(splunkContext.bindings).to.include.keys('failedParseEventsOutputBlob');
      expect(splunkContext.bindings).to.not.include.keys('failedSendEventsOutputBlob');
      expect(splunkContext.bindings.failedParseEventsOutputBlob).to.equal(eventHubMessages);
    });

    it('should save invalid event', async () => {
      const eventHubMessages = [{
        record: [
          {
            'Foo': 'invalid event',
          }
        ]
      }];

      await azureMonitorLogsProcessorFunc(splunkContext, eventHubMessages);

      expect(splunkContext.bindings).to.include.keys('failedParseEventsOutputBlob');
      expect(splunkContext.bindings).to.not.include.keys('failedSendEventsOutputBlob');
      expect(splunkContext.bindings.failedParseEventsOutputBlob).to.equal(eventHubMessages);
    });

    it('should save events when hecUrl is not provided', async () => {
      sandbox.stub(process.env, 'HecUrl').value(undefined);
      const eventHubMessages = [{
        records: [
          {
            'Foo': 'from_msg1',
          },
          {
            'Foo': 'from_msg2',
          }
        ]
      }];

      await azureMonitorLogsProcessorFunc(splunkContext, eventHubMessages);

      expect(splunkContext.bindings).to.include.keys('failedParseEventsOutputBlob');
      expect(splunkContext.bindings).to.not.include.keys('failedSendEventsOutputBlob');
      expect(splunkContext.bindings.failedParseEventsOutputBlob).to.equal(eventHubMessages);
    });

    it('should save batch on hec bad response', async () => {
      httpClientStub.returns({ post: postStub });
      postStub.resolves({ status: 500 });

      const eventHubMessages = [{ records: [{ 'Foo': 'bar' }] }];
      const expectedOutputBlob = `{"event":{"Foo":"bar","data_manager_input_id":"mock-input-id"},` +
        `"source":"azure:mock_region:Mock-0-Namespace1:mock-eh-name"` +
        `,"sourcetype":"mock_sourcetype"}`;

      await azureMonitorLogsProcessorFunc(splunkContext, eventHubMessages);

      expect(splunkContext.bindings).to.not.include.keys('failedParseEventsOutputBlob');
      expect(splunkContext.bindings).to.include.keys('failedSendEventsOutputBlob');
      expect(splunkContext.bindings.failedSendEventsOutputBlob).to.equal(expectedOutputBlob);
    });

    it('should save multiple batches on hec bad response', async () => {
      sandbox.stub(process.env, 'SPLUNK_BATCH_MAX_SIZE_BYTES').value(1);
      httpClientStub.returns({ post: postStub });
      postStub.resolves({ status: 500 });

      const eventHubMessages = [
        {
          records: [
            {
              'Foo': 'from_msg1',
            }
          ],
        },
        {
          records: [
            {
              'Foo': 'from_msg2',
            }
          ],
        },
      ];

      const expectedOutputBlob = `{"event":{"Foo":"from_msg1","data_manager_input_id":"mock-input-id"},` +
        `"source":"azure:mock_region:Mock-0-Namespace1:mock-eh-name"` +
        `,"sourcetype":"mock_sourcetype"}` +
        `\n` +
        `{"event":{"Foo":"from_msg2","data_manager_input_id":"mock-input-id"},` +
        `"source":"azure:mock_region:Mock-0-Namespace1:mock-eh-name"` +
        `,"sourcetype":"mock_sourcetype"}`;

      await azureMonitorLogsProcessorFunc(splunkContext, eventHubMessages);

      expect(splunkContext.bindings).to.not.include.keys('failedParseEventsOutputBlob');
      expect(splunkContext.bindings).to.include.keys('failedSendEventsOutputBlob');
      expect(splunkContext.bindings.failedSendEventsOutputBlob).to.equal(expectedOutputBlob);
    });

    it('should save select batches on select hec bad responses', async () => {
      sandbox.stub(process.env, 'SPLUNK_BATCH_MAX_SIZE_BYTES').value(1);
      httpClientStub.returns({ post: postStub });
      postStub
        .onFirstCall()
        .resolves({ status: 200 })
        .onSecondCall()
        .resolves({ status: 500 });

      const eventHubMessages = [
        {
          records: [{
            'Foo': 'from_msg1',
          }],
        },
        {
          records: [{
            'Foo': 'from_msg2',
          }],
        },
      ];

      const expectedOutputBlob = `{"event":{"Foo":"from_msg2","data_manager_input_id":"mock-input-id"},` +
        `"source":"azure:mock_region:Mock-0-Namespace1:mock-eh-name"` +
        `,"sourcetype":"mock_sourcetype"}`;

      await azureMonitorLogsProcessorFunc(splunkContext, eventHubMessages);

      expect(splunkContext.bindings).to.not.include.keys('failedParseEventsOutputBlob');
      expect(splunkContext.bindings).to.include.keys('failedSendEventsOutputBlob');
      expect(splunkContext.bindings.failedSendEventsOutputBlob).to.equal(expectedOutputBlob);
    });
  });
});