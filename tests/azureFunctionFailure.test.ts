import axios, { AxiosInstance } from 'axios';
import { expect } from 'chai';
import { ungzip } from 'node-gzip';
import { SinonStub } from 'sinon';
import { InputType } from 'zlib';

import azureMonitorLogsProcessorFunc from '../azure_monitor_logs_processor_func/index';
import { context, mockEnv, sandbox, validRecord } from './common';

const splunkContext: any = context;

// batchSerializedEvents concatenates multiple JSON-serialized events with no delimiter
// (HEC's /services/collector/event endpoint parses concatenated JSON objects directly), so
// splitting on '\n' doesn't work here — scan for balanced top-level '{...}' documents instead.
function splitConcatenatedJson(text: string): any[] {
  const events: any[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      if (depth === 0) {
        start = i;
      }
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && start !== -1) {
        events.push(JSON.parse(text.slice(start, i + 1)));
        start = -1;
      }
    }
  }
  return events;
}

async function uncompressPayloadEvents(payload: InputType): Promise<any[]> {
  const text = (await ungzip(payload)).toString();
  return splitConcatenatedJson(text);
}

describe('Azure Monitor Logs Process', function () {
  describe('Failed Events', () => {
    let httpClientStub: SinonStub;
    let postStub: SinonStub;
    let clientInstance: AxiosInstance;

    this.beforeEach(() => {
      clientInstance = axios.create();
      httpClientStub = sandbox.stub(axios, 'create');
      postStub = sandbox.stub();
      clientInstance.post = postStub;
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

    it('should not let a record with a hasOwnProperty-shadowing field crash the whole batch (review finding: record.hasOwnProperty(...) trusts an attacker-controlled own property instead of the built-in)', async () => {
      httpClientStub.returns(clientInstance);
      postStub.resolves({ status: 200 });

      // Schema-valid record that shadows the inherited Object.prototype.hasOwnProperty with
      // an own property of the same name — record.hasOwnProperty('time') would then try to
      // call null(...) and throw, which (before the fix) propagated all the way to the
      // top-level catch and backed up this ENTIRE batch, including the valid sibling message,
      // instead of sending either to Splunk.
      const poisonedRecord = { ...validRecord, hasOwnProperty: null };
      const eventHubMessages = [
        { records: [poisonedRecord] },
        { records: [{ ...validRecord, 'Foo': 'valid record' }] },
      ];

      await azureMonitorLogsProcessorFunc(splunkContext, eventHubMessages);

      expect(splunkContext.bindings).to.not.include.keys('failedParseEventsOutputBlob');
      expect(splunkContext.bindings).to.not.include.keys('failedSendEventsOutputBlob');
      expect(postStub.calledOnce).to.be.true;
    });

    it('should save invalid event', async () => {
      httpClientStub.returns(clientInstance);
      postStub.resolves({ status: 200 });

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
      expect(splunkContext.bindings.failedParseEventsOutputBlob).to.deep.equal(eventHubMessages);
      expect(postStub.called).to.be.false;
    });

    it('should quarantine an invalid message without blocking valid messages in the same batch', async () => {
      httpClientStub.returns(clientInstance);
      postStub.resolves({ status: 200 });

      const invalidMessage = { record: [{ 'Foo': 'invalid event' }] };
      const validMessage = { records: [{ ...validRecord, 'Foo': 'valid event' }] };
      const eventHubMessages = [invalidMessage, validMessage];

      await azureMonitorLogsProcessorFunc(splunkContext, eventHubMessages);

      expect(splunkContext.bindings).to.include.keys('failedParseEventsOutputBlob');
      expect(splunkContext.bindings).to.not.include.keys('failedSendEventsOutputBlob');
      expect(splunkContext.bindings.failedParseEventsOutputBlob).to.deep.equal([invalidMessage]);
      expect(postStub.calledOnce).to.be.true;
    });

    it('should quarantine an invalid record without blocking valid records in the same message', async () => {
      httpClientStub.returns(clientInstance);
      postStub.resolves({ status: 200 });

      const eventHubMessages = [{
        records: [
          null,
          { ...validRecord, 'Foo': 'valid record' }
        ]
      }];

      await azureMonitorLogsProcessorFunc(splunkContext, eventHubMessages);

      expect(splunkContext.bindings).to.include.keys('failedParseEventsOutputBlob');
      expect(splunkContext.bindings).to.not.include.keys('failedSendEventsOutputBlob');
      expect(splunkContext.bindings.failedParseEventsOutputBlob).to.deep.equal([null]);
      expect(postStub.calledOnce).to.be.true;
    });

    it('should quarantine an invalid record without blocking valid records when eventhub metadata is enabled', async () => {
      sandbox.stub(process.env, 'EnableEventhubMetadata').value('true');
      httpClientStub.returns(clientInstance);
      postStub.resolves({ status: 200 });

      const eventHubMessages = [{
        records: [
          null,
          { ...validRecord, 'Foo': 'valid record' }
        ]
      }];

      await azureMonitorLogsProcessorFunc(splunkContext, eventHubMessages);

      expect(splunkContext.bindings).to.include.keys('failedParseEventsOutputBlob');
      expect(splunkContext.bindings).to.not.include.keys('failedSendEventsOutputBlob');
      expect(splunkContext.bindings.failedParseEventsOutputBlob).to.deep.equal([null]);
      expect(postStub.calledOnce).to.be.true;
    });

    it('should still add __eventhub_metadata to an unrecognized record when eventhub metadata is enabled (intentional: metadata is Event Hub system data, not content, and helps locate/investigate the raw record — review finding response, kept as-is)', async () => {
      sandbox.stub(process.env, 'EnableEventhubMetadata').value('true');
      sandbox.stub(splunkContext.bindingData, 'systemPropertiesArray').value([{ lemon: 'tree' }]);
      httpClientStub.returns(clientInstance);
      postStub.resolves({ status: 200 });

      const attackerRecord = { arbitrary: 'json', injected: true };
      const eventHubMessages = [{ records: [attackerRecord] }];

      await azureMonitorLogsProcessorFunc(splunkContext, eventHubMessages);

      expect(splunkContext.bindings).to.not.include.keys('failedParseEventsOutputBlob');
      expect(postStub.calledOnce).to.be.true;

      const events = await uncompressPayloadEvents(postStub.firstCall.args[1]);
      expect(events[0].event).to.deep.equal({ ...attackerRecord, __eventhub_metadata: { lemon: 'tree' } });
    });

    it('should forward (not quarantine) a record with no event-identifying field at all, unmodified — no property added (accepted-risk tradeoff)', async () => {
      httpClientStub.returns(clientInstance);
      postStub.resolves({ status: 200 });

      // A record with no relation to any Azure Monitor log shape, injected by anyone
      // with Event Hub Send permission. Matches none of
      // EVENT_IDENTIFYING_FIELDS — no longer quarantined, forwarded to Splunk as-is instead,
      // so it's not lost in an unmonitored per-customer blob. Nothing is added to the event;
      // the fact that it was unrecognized is only noted in the function's own log output.
      const attackerRecord = { arbitrary: 'json', injected: true, sensitiveField: 'exfil-attempt' };
      const eventHubMessages = [{
        records: [
          attackerRecord,
          { ...validRecord, 'Foo': 'valid record' }
        ]
      }];

      await azureMonitorLogsProcessorFunc(splunkContext, eventHubMessages);

      expect(splunkContext.bindings).to.not.include.keys('failedParseEventsOutputBlob');
      expect(splunkContext.bindings).to.not.include.keys('failedSendEventsOutputBlob');
      expect(postStub.calledOnce).to.be.true;

      const events = await uncompressPayloadEvents(postStub.firstCall.args[1]);
      const forwarded = events.find((e: any) => e.event.injected === true);
      expect(forwarded).to.exist;
      expect(forwarded.event).to.deep.equal(attackerRecord);
      expect(forwarded.fields).to.deep.equal({ data_manager_input_id: 'mock-input-id' });
      const validEvent = events.find((e: any) => e.event.Foo === 'valid record');
      expect(validEvent).to.exist;
    });

    it('should forward (not quarantine) a record whose only event-identifying field is null, unmodified (minLength:1 still applies for the recognized/unrecognized distinction)', async () => {
      httpClientStub.returns(clientInstance);
      postStub.resolves({ status: 200 });

      // `required` alone only checks key presence, not value — without the `minLength: 1`
      // type constraint, `{ operationName: null }` would satisfy `required: ['operationName']`
      // despite carrying no actual identifying data.
      const attackerRecord = { operationName: null, arbitrary: 'json' };
      const eventHubMessages = [{ records: [attackerRecord] }];

      await azureMonitorLogsProcessorFunc(splunkContext, eventHubMessages);

      expect(splunkContext.bindings).to.not.include.keys('failedParseEventsOutputBlob');
      expect(postStub.calledOnce).to.be.true;

      const events = await uncompressPayloadEvents(postStub.firstCall.args[1]);
      expect(events[0].event).to.deep.equal(attackerRecord);
      expect(events[0].fields).to.deep.equal({ data_manager_input_id: 'mock-input-id' });
    });

    it('should forward (not quarantine) a record whose only event-identifying field is an empty string, unmodified', async () => {
      httpClientStub.returns(clientInstance);
      postStub.resolves({ status: 200 });

      const attackerRecord = { category: '', arbitrary: 'json' };
      const eventHubMessages = [{ records: [attackerRecord] }];

      await azureMonitorLogsProcessorFunc(splunkContext, eventHubMessages);

      expect(splunkContext.bindings).to.not.include.keys('failedParseEventsOutputBlob');
      expect(postStub.calledOnce).to.be.true;

      const events = await uncompressPayloadEvents(postStub.firstCall.args[1]);
      expect(events[0].event).to.deep.equal(attackerRecord);
      expect(events[0].fields).to.deep.equal({ data_manager_input_id: 'mock-input-id' });
    });

    it('should accept a record identified only by `type` (Application Insights convention)', async () => {
      httpClientStub.returns(clientInstance);
      postStub.resolves({ status: 200 });

      const eventHubMessages = [{ records: [{ type: 'AppTraces', message: 'hello' }] }];

      await azureMonitorLogsProcessorFunc(splunkContext, eventHubMessages);

      expect(splunkContext.bindings).to.not.include.keys('failedParseEventsOutputBlob');
      expect(splunkContext.bindings).to.not.include.keys('failedSendEventsOutputBlob');
      expect(postStub.calledOnce).to.be.true;
    });

    it('should accept a WAD/ETW-shaped record identified only by PascalCase `OperationName` (observed real-world Microsoft-Windows-WebSites shape)', async () => {
      httpClientStub.returns(clientInstance);
      postStub.resolves({ status: 200 });

      const wadRecord = {
        EventOsInstanceId: '5176a340-a966-456d-813d-1a334790060c',
        ProviderGuid: 'e4d907c4-42e4-4377-87da-d394e98cb392',
        ProviderName: 'Microsoft-Windows-WebSites',
        Time: '2026-09-14 11:32:56Z',
        CorrelationId: 'b679995d-aea6-4a2e-8400-cec4aca485e2',
        Category: 'Administrative',
        ResourceId: '/SUBSCRIPTIONS/.../SITES/SPLKAADLOGSFNFF7EFA9F',
        OperationName: 'UpdateWebSite',
        ResultType: 'Succeeded',
        Identity: { Claims: null },
        Properties: { Message: '' },
        ResultDescription: 'WebSite ... has an operation Update and the status is Succeeded',
      };
      const eventHubMessages = [{ records: [wadRecord] }];

      await azureMonitorLogsProcessorFunc(splunkContext, eventHubMessages);

      expect(splunkContext.bindings).to.not.include.keys('failedParseEventsOutputBlob');
      expect(splunkContext.bindings).to.not.include.keys('failedSendEventsOutputBlob');
      expect(postStub.calledOnce).to.be.true;
    });

    it('should accept a Global Secure Access-shaped record identified only by `Action`', async () => {
      httpClientStub.returns(clientInstance);
      postStub.resolves({ status: 200 });

      const gsaRecord = {
        SourceIp: '10.0.0.5',
        DestinationIp: '52.1.2.3',
        Action: 'Allowed',
        AccessType: 'PrivateAccess',
      };
      const eventHubMessages = [{ records: [gsaRecord] }];

      await azureMonitorLogsProcessorFunc(splunkContext, eventHubMessages);

      expect(splunkContext.bindings).to.not.include.keys('failedParseEventsOutputBlob');
      expect(splunkContext.bindings).to.not.include.keys('failedSendEventsOutputBlob');
      expect(postStub.calledOnce).to.be.true;
    });

    it('should accept a record identified only by `Status` (e.g. RemoteNetworkHealthLogs-shaped)', async () => {
      httpClientStub.returns(clientInstance);
      postStub.resolves({ status: 200 });

      const eventHubMessages = [{ records: [{ SourceIp: '10.0.0.1', Status: 'tunnelConnected', RemoteNetworkId: 'rn-1' }] }];

      await azureMonitorLogsProcessorFunc(splunkContext, eventHubMessages);

      expect(splunkContext.bindings).to.not.include.keys('failedParseEventsOutputBlob');
      expect(splunkContext.bindings).to.not.include.keys('failedSendEventsOutputBlob');
      expect(postStub.calledOnce).to.be.true;
    });

    it('should accept a record identified only by `AlertType`/`DisplayName` (e.g. NetworkAccessAlerts-shaped)', async () => {
      httpClientStub.returns(clientInstance);
      postStub.resolves({ status: 200 });

      const eventHubMessages = [{ records: [{ AlertType: 'SuspiciousTraffic', DisplayName: 'Suspicious traffic detected', Severity: 'High' }] }];

      await azureMonitorLogsProcessorFunc(splunkContext, eventHubMessages);

      expect(splunkContext.bindings).to.not.include.keys('failedParseEventsOutputBlob');
      expect(splunkContext.bindings).to.not.include.keys('failedSendEventsOutputBlob');
      expect(postStub.calledOnce).to.be.true;
    });

    it('should accept a record identified only by `EventType` (e.g. NetworkAccessConnectionEvents-shaped)', async () => {
      httpClientStub.returns(clientInstance);
      postStub.resolves({ status: 200 });

      const eventHubMessages = [{ records: [{ SourceIp: '10.0.0.1', EventType: 'ConnectionEstablished', DestinationIp: '52.1.2.3' }] }];

      await azureMonitorLogsProcessorFunc(splunkContext, eventHubMessages);

      expect(splunkContext.bindings).to.not.include.keys('failedParseEventsOutputBlob');
      expect(splunkContext.bindings).to.not.include.keys('failedSendEventsOutputBlob');
      expect(postStub.calledOnce).to.be.true;
    });

    it('should accept a record identified only by `Activity` (e.g. NetworkAccessGenerativeAIInsights-shaped)', async () => {
      httpClientStub.returns(clientInstance);
      postStub.resolves({ status: 200 });

      const eventHubMessages = [{ records: [{ Activity: 'Prompt', DestinationUrl: 'https://ai.contoso.com' }] }];

      await azureMonitorLogsProcessorFunc(splunkContext, eventHubMessages);

      expect(splunkContext.bindings).to.not.include.keys('failedParseEventsOutputBlob');
      expect(splunkContext.bindings).to.not.include.keys('failedSendEventsOutputBlob');
      expect(postStub.calledOnce).to.be.true;
    });

    it('should accept a record identified only by `Operation` (e.g. EnrichedOffice365AuditLogs-shaped), including one with SourceIp null (observed real-world caveat for Entra ID sub-events)', async () => {
      httpClientStub.returns(clientInstance);
      postStub.resolves({ status: 200 });

      const eventHubMessages = [{ records: [{ Operation: 'FileAccessed', SourceIp: null, Workload: 'SharePoint' }] }];

      await azureMonitorLogsProcessorFunc(splunkContext, eventHubMessages);

      expect(splunkContext.bindings).to.not.include.keys('failedParseEventsOutputBlob');
      expect(splunkContext.bindings).to.not.include.keys('failedSendEventsOutputBlob');
      expect(postStub.calledOnce).to.be.true;
    });

    it('should accept a record missing the top-level time field (observed real-world AzureADGraphActivityLogs shape) — `time` is not validated at all under the minimal floor', async () => {
      httpClientStub.returns(clientInstance);
      postStub.resolves({ status: 200 });

      const { time, ...recordWithoutTime } = validRecord;
      const eventHubMessages = [{ records: [recordWithoutTime] }];

      await azureMonitorLogsProcessorFunc(splunkContext, eventHubMessages);

      expect(splunkContext.bindings).to.not.include.keys('failedParseEventsOutputBlob');
      expect(splunkContext.bindings).to.not.include.keys('failedSendEventsOutputBlob');
      expect(postStub.calledOnce).to.be.true;
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
      httpClientStub.returns(clientInstance);
      postStub.resolves({ status: 500 });

      const eventHubMessages = [{ records: [{ ...validRecord, Foo: 'bar' }] }];
      const expectedOutputBlob = JSON.stringify({
        event: { ...validRecord, Foo: 'bar' },
        source: 'azure:mock_region:Mock-0-Namespace1:mock-eh-name',
        sourcetype: 'mock_sourcetype',
        fields: { data_manager_input_id: 'mock-input-id' },
        time: 1548108866979,
        index: 'bastion',
      });

      await azureMonitorLogsProcessorFunc(splunkContext, eventHubMessages);

      expect(splunkContext.bindings).to.not.include.keys('failedParseEventsOutputBlob');
      expect(splunkContext.bindings).to.include.keys('failedSendEventsOutputBlob');
      expect(splunkContext.bindings.failedSendEventsOutputBlob).to.equal(expectedOutputBlob);
    });

    it('should save multiple batches on hec bad response', async () => {
      sandbox.stub(process.env, 'SPLUNK_BATCH_MAX_SIZE_BYTES').value(1);
      httpClientStub.returns(clientInstance);
      postStub.resolves({ status: 500 });

      const eventHubMessages = [
        {
          records: [
            {
              ...validRecord,
              Foo: 'from_msg1',
            }
          ],
        },
        {
          records: [
            {
              ...validRecord,
              Foo: 'from_msg2',
            }
          ],
        },
      ];

      const expectedOutputBlob = [
        JSON.stringify({
          event: { ...validRecord, Foo: 'from_msg1' },
          source: 'azure:mock_region:Mock-0-Namespace1:mock-eh-name',
          sourcetype: 'mock_sourcetype',
          fields: { data_manager_input_id: 'mock-input-id' },
          time: 1548108866979,
          index: 'bastion',
        }),
        JSON.stringify({
          event: { ...validRecord, Foo: 'from_msg2' },
          source: 'azure:mock_region:Mock-0-Namespace1:mock-eh-name',
          sourcetype: 'mock_sourcetype',
          fields: { data_manager_input_id: 'mock-input-id' },
          time: 1548108866979,
          index: 'bastion',
        }),
      ].join('\n');

      await azureMonitorLogsProcessorFunc(splunkContext, eventHubMessages);

      expect(splunkContext.bindings).to.not.include.keys('failedParseEventsOutputBlob');
      expect(splunkContext.bindings).to.include.keys('failedSendEventsOutputBlob');
      expect(splunkContext.bindings.failedSendEventsOutputBlob).to.equal(expectedOutputBlob);
    });

    it('should save select batches on select hec bad responses', async () => {
      sandbox.stub(process.env, 'SPLUNK_BATCH_MAX_SIZE_BYTES').value(1);
      httpClientStub.returns(clientInstance);
      postStub
        .onFirstCall()
        .resolves({ status: 200 })
        .onSecondCall()
        .resolves({ status: 500 });

      const eventHubMessages = [
        {
          records: [{
            ...validRecord,
            Foo: 'from_msg1',
          }],
        },
        {
          records: [{
            ...validRecord,
            Foo: 'from_msg2',
          }],
        },
      ];

      const expectedOutputBlob = JSON.stringify({
        event: { ...validRecord, Foo: 'from_msg2' },
        source: 'azure:mock_region:Mock-0-Namespace1:mock-eh-name',
        sourcetype: 'mock_sourcetype',
        fields: { data_manager_input_id: 'mock-input-id' },
        time: 1548108866979,
        index: 'bastion',
      });

      await azureMonitorLogsProcessorFunc(splunkContext, eventHubMessages);

      expect(splunkContext.bindings).to.not.include.keys('failedParseEventsOutputBlob');
      expect(splunkContext.bindings).to.include.keys('failedSendEventsOutputBlob');
      expect(splunkContext.bindings.failedSendEventsOutputBlob).to.equal(expectedOutputBlob);
    });
  });
});