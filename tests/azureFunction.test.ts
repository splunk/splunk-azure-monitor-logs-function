import axios from 'axios';
import { expect } from 'chai';
import { SinonStub } from 'sinon';

import azureMonitorLogsProcessorFunc from '../azure_monitor_logs_processor_func/index';
import { context, mockEnv, sandbox } from './common';

const splunkContext: any = context;

describe('Azure Monitor Logs Process', function () {
  describe('Push events', () => {
    let httpClientStub: SinonStub;
    let postStub: SinonStub;

    this.beforeEach(() => {
      httpClientStub = sandbox.stub(axios, 'create');
      postStub = sandbox.stub();
      sandbox.stub(process, 'env').value(mockEnv);
    });

    this.afterEach(() => {
      sandbox.restore();
    });

    it('should create httpClient with correct params', async () => {
      httpClientStub.returns({
        post: postStub
      })
      postStub.resolves({
        status: 200
      })
      const eventHubMessages = [{ records: [{ 'Foo': 'bar' }] }];
      await azureMonitorLogsProcessorFunc(splunkContext, eventHubMessages);

      expect(httpClientStub.calledOnce).to.be.true;
      expect(httpClientStub.firstCall.args.length).to.equal(1);
      expect(httpClientStub.firstCall.args[0]).to.include.keys('baseURL', 'headers');
      expect(httpClientStub.firstCall.args[0].baseURL).to.equal(mockEnv.HecUrl);
      expect(httpClientStub.firstCall.args[0].headers).to.deep.equal({
        Authorization: `Splunk ${mockEnv.HecToken}`
      });
    });

    it('should call post correct params', async () => {
      httpClientStub.returns({ post: postStub });
      postStub.resolves({ status: 200 });

      const eventHubMessages = [{ records: [{ 'Foo': 'bar' }] }];
      await azureMonitorLogsProcessorFunc(splunkContext, eventHubMessages);

      expect(postStub.calledOnce).is.true;
      expect(postStub.firstCall.args).to.deep.equal([
        'services/collector/event',
        `{"event":{"Foo":"bar","data_manager_input_id":"${mockEnv.DataManagerInputId}"},` +
        `"source":"azure:${mockEnv.Region}:${mockEnv.EventHubNamespace}:${mockEnv.EventHubName}",` +
        `"sourcetype":"${mockEnv.SourceType}"}`
      ]);
    });

    it('should populate all fields in splunk event', async () => {
      httpClientStub.returns({ post: postStub });
      postStub.resolves({ status: 200 });

      const eventHubMessages = [{ records: [{ 'Foo': 'bar' }] }];
      await azureMonitorLogsProcessorFunc(splunkContext, eventHubMessages);

      expect(postStub.calledOnce).is.true;
      expect(postStub.firstCall.args.length).to.equal(2);

      const splunkEvent = JSON.parse(postStub.firstCall.args[1]);
      expect(splunkEvent).to.include.keys('event', 'source', 'sourcetype')
      expect(splunkEvent.source).to.equal(`azure:${mockEnv.Region}:${mockEnv.EventHubNamespace}:${mockEnv.EventHubName}`);
      expect(splunkEvent.sourcetype).to.equal(mockEnv.SourceType);
      expect(splunkEvent.event).to.include.keys('Foo', 'data_manager_input_id');
      expect(splunkEvent.event.Foo).to.equal('bar');
      expect(splunkEvent.event.data_manager_input_id).to.equal(mockEnv.DataManagerInputId);
    });

    it('should batch events', async () => {
      sandbox.stub(process.env, 'SPLUNK_BATCH_MAX_SIZE_BYTES').value(400);
      httpClientStub.returns({ post: postStub });
      postStub.resolves({ status: 200 });

      const eventHubMessages = [
        {
          records: [
            {
              Foo: 'from_msg1_batch_1',
            }
          ]
        },
        {
          records: [
            {
              'Foo': 'from_msg2_batch_1',
            },
            {
              'Foo': 'from_msg2_batch_2',
            },
          ]
        },
      ];
      await azureMonitorLogsProcessorFunc(splunkContext, eventHubMessages);

      expect(postStub.callCount).to.equal(2);
      expect(postStub.firstCall.args.length).to.equal(2);
      expect(postStub.firstCall.args[1]).to.contain('batch_1');
      expect(postStub.firstCall.args[1]).to.not.contain('batch_2');
      expect(postStub.secondCall.args.length).to.equal(2);
      expect(postStub.secondCall.args[1]).to.not.contain('batch_1');
      expect(postStub.secondCall.args[1]).to.contain('batch_2');
    });
  });
});