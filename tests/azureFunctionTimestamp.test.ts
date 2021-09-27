import axios from 'axios';
import { expect } from 'chai';
import { SinonStub } from 'sinon';

import azureMonitorLogsProcessorFunc from '../azure_monitor_logs_processor_func/index';
import { context, mockEnv, sandbox } from './common';

const splunkContext: any = context;

describe('Azure Monitor Logs Process', function () {
  describe('Extract timestamp', function () {
    let httpClientStub: SinonStub;
    let postStub: SinonStub;

    this.beforeEach(() => {
      sandbox.stub(process, 'env').value(mockEnv);
      httpClientStub = sandbox.stub(axios, 'create');
      postStub = sandbox.stub();
      httpClientStub.returns({ post: postStub });
      postStub.resolves({ status: 200 });
    });

    this.afterEach(() => {
      sandbox.restore();
    });

    /**
     * Most commonly used timestamp including Azure
     */
    it('should extract iso 8601 timestamp', async () => {
      const time = '2021-06-09T20:20:37.6037942Z';
      const eventHubMessages = [{ records: [{ 'Foo': 'bar', time }] }];
      await azureMonitorLogsProcessorFunc(splunkContext, eventHubMessages);

      expect(postStub.calledOnce).is.true;
      expect(postStub.firstCall.args.length).to.equal(2);

      const splunkEvent = JSON.parse(postStub.firstCall.args[1]);
      expect(splunkEvent).to.include.keys('time');
      expect(splunkEvent.time).to.equal(1623270037603);
    });

    /**
     * This timestamp was observed in AAD logs
     */
    it('should extract aad timestamp', async () => {
      const time = '6/9/2021 8:20:37 PM';
      const eventHubMessages = [{ records: [{ 'Foo': 'bar', time }] }];
      await azureMonitorLogsProcessorFunc(splunkContext, eventHubMessages);

      expect(postStub.calledOnce).is.true;
      expect(postStub.firstCall.args.length).to.equal(2);

      const splunkEvent = JSON.parse(postStub.firstCall.args[1]);
      expect(splunkEvent).to.include.keys('time');
      expect(splunkEvent.time).to.equal(1623270037000);
    });

    it('should extract non utc timestamp', async () => {
      const time = '2021-06-09T20:20:37.603794-0500';
      const eventHubMessages = [{ records: [{ 'Foo': 'bar', time }] }];
      await azureMonitorLogsProcessorFunc(splunkContext, eventHubMessages);

      expect(postStub.calledOnce).is.true;
      expect(postStub.firstCall.args.length).to.equal(2);

      const splunkEvent = JSON.parse(postStub.firstCall.args[1]);
      expect(splunkEvent).to.include.keys('time');
      expect(splunkEvent.time).to.equal(1623288037603);
    });

    it('should skip invalid timestamp', async () => {
      const time = 'invalid';
      const eventHubMessages = [{ records: [{ 'Foo': 'bar', time }] }];
      await azureMonitorLogsProcessorFunc(splunkContext, eventHubMessages);

      expect(postStub.calledOnce).is.true;
      expect(postStub.firstCall.args.length).to.equal(2);

      const splunkEvent = JSON.parse(postStub.firstCall.args[1]);
      expect(splunkEvent).to.not.include.keys('time');
    });
  });
});