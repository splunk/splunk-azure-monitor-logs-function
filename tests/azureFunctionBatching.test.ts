import { expect } from 'chai';
import { context, createEvents, mockEnv, sandbox } from './common';

const rewire = require('rewire');
const functionModule = rewire('../azure_monitor_logs_processor_func/index.ts')
const batchSerializedEvents = functionModule.__get__('batchSerializedEvents');

describe('Azure Monitor Logs Process', function () {
  describe('Batch Events', function () {
    this.beforeEach(() => {
      sandbox.stub(process, 'env').value(mockEnv);
    });

    this.afterEach(() => {
      sandbox.restore();
    });

    it('should handle empty logs', () => {
      const events: string[] = [];
      const batches = batchSerializedEvents(context.log, events, 3);
      expect(batches).to.deep.equal([]);
    });

    it('should batch single log into single batch', () => {
      const events = createEvents(1, 3);
      const batches = batchSerializedEvents(context.log, events, 3);
      expect(batches).to.deep.equal(['aaa']);
    });

    it('should batch single large log into single batch', () => {
      const events = createEvents(1, 4);
      const batches = batchSerializedEvents(context.log, events, 3);
      expect(batches).to.deep.equal(['aaaa']);
    });

    it('should batch multiple logs into a single batch', () => {
      const events = createEvents(2, 1);
      const batches = batchSerializedEvents(context.log, events, 3);
      expect(batches).to.deep.equal(['aa']);
    });

    it('should batch multiple logs that fit exactly into a single batch', () => {
      const events = createEvents(3, 1);
      const batches = batchSerializedEvents(context.log, events, 3);
      expect(batches).to.deep.equal(['aaa']);
    });

    it('should batch multiple logs that overflow into 2 batches', () => {
      const events = createEvents(4, 1);
      const batches = batchSerializedEvents(context.log, events, 3);
      expect(batches).to.deep.equal(['aaa', 'a']);
    });

    it('should batch multiple logs that overflow into 2 batches', () => {
      const events = createEvents(4, 1);
      const batches = batchSerializedEvents(context.log, events, 3);
      expect(batches).to.deep.equal(['aaa', 'a']);
    });

    it('should batch multiple logs that overflow into 3 batches', () => {
      const events = createEvents(9, 1);
      const batches = batchSerializedEvents(context.log, events, 3);
      expect(batches).to.deep.equal(['aaa', 'aaa', 'aaa']);
    });

    it('should batch multiple logs, the first large and others that do not overflow', () => {
      const events = createEvents(1, 4);
      events.push(...createEvents(3, 1));
      const batches = batchSerializedEvents(context.log, events, 3);
      expect(batches).to.deep.equal(['aaaa', 'aaa']);
    });
  });
});
