/**
 * Copyright Microsoft Corporation. All rights reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { FixturePool, rerunRegistrations, setParameters } from './fixtures';
import { EventEmitter } from 'events';
import { setCurrentTestFile } from './expect';
import { Test, Suite, Configuration, serializeError } from './test';
import { spec } from './spec';
import { RunnerConfig } from './runnerConfig';

export const fixturePool = new FixturePool<RunnerConfig>();

export type TestRunnerEntry = {
  file: string;
  ordinals: number[];
  configurationString: string;
  configuration: Configuration;
  hash: string;
};

export class TestRunner extends EventEmitter {
  private _currentOrdinal = -1;
  private _failedWithError: any | undefined;
  private _fatalError: any | undefined;
  private _file: any;
  private _ordinals: Set<number>;
  private _remaining: Set<number>;
  private _trialRun: any;
  private _configuredFile: any;
  private _parsedGeneratorConfiguration: any = {};
  private _config: RunnerConfig;
  private _timeout: number;

  constructor(entry: TestRunnerEntry, config: RunnerConfig, workerId: number) {
    super();
    this._file = entry.file;
    this._ordinals = new Set(entry.ordinals);
    this._remaining = new Set(entry.ordinals);
    this._trialRun = config.trialRun;
    this._timeout = config.timeout;
    this._config = config;
    this._configuredFile = entry.file + `::[${entry.configurationString}]`;
    for (const {name, value} of entry.configuration)
      this._parsedGeneratorConfiguration[name] = value;
    this._parsedGeneratorConfiguration['parallelIndex'] = workerId;
    setCurrentTestFile(this._file);
  }

  stop() {
    this._trialRun = true;
  }

  async run() {
    setParameters(this._parsedGeneratorConfiguration);

    const suite = new Suite('');
    const revertBabelRequire = spec(suite, this._file, this._timeout);
    require(this._file);
    revertBabelRequire();
    suite._renumber();

    rerunRegistrations(this._file, 'test');
    await this._runSuite(suite);
    this._reportDone();
  }

  private async _runSuite(suite: Suite) {
    try {
      await this._runHooks(suite, 'beforeAll', 'before');
    } catch (e) {
      this._fatalError = serializeError(e);
      this._reportDone();
    }
    for (const entry of suite._entries) {
      if (entry instanceof Suite) {
        await this._runSuite(entry);
      } else {
        await this._runTest(entry);
      }
    }
    try {
      await this._runHooks(suite, 'afterAll', 'after');
    } catch (e) {
      this._fatalError = serializeError(e);
      this._reportDone();
    }
  }

  private async _runTest(test: Test) {
    if (this._failedWithError)
      return false;
    const ordinal = ++this._currentOrdinal;
    if (this._ordinals.size && !this._ordinals.has(ordinal))
      return;
    this._remaining.delete(ordinal);
    if (test.pending || test.suite._isPending()) {
      this.emit('pending', { test: this._serializeTest(test) });
      return;
    }

    this.emit('test', { test: this._serializeTest(test) });
    try {
      await this._runHooks(test.suite, 'beforeEach', 'before');
      test._startTime = Date.now();
      if (!this._trialRun)
        await this._testWrapper(test)();
      this.emit('pass', { test: this._serializeTest(test) });
      await this._runHooks(test.suite, 'afterEach', 'after');
    } catch (error) {
      test.error = serializeError(error);
      this._failedWithError = test.error;
      this.emit('fail', {
        test: this._serializeTest(test),
      });
    }
  }

  private async _runHooks(suite: Suite, type: string, dir: 'before' | 'after') {
    if (!suite._hasTestsToRun())
      return;
    const all = [];
    for (let s = suite; s; s = s.parent) {
      const funcs = s._hooks.filter(e => e.type === type).map(e => e.fn);
      all.push(...funcs.reverse());
    }
    if (dir === 'before')
      all.reverse();
    for (const hook of all)
      await fixturePool.resolveParametersAndRun(hook, 0, this._config);
  }

  private _reportDone() {
    this.emit('done', {
      error: this._failedWithError,
      fatalError: this._fatalError,
      remaining: [...this._remaining],
    });
  }

  private _testWrapper(test: Test) {
    const timeout = test.slow ? this._timeout * 3 : this._timeout;
    return fixturePool.wrapTestCallback(test.fn, timeout, { ...this._config }, test);
  }

  private _serializeTest(test) {
    return {
      id: `${test._ordinal}@${this._configuredFile}`,
      error: test.error,
      duration: Date.now() - test._startTime,
    };
  }
}
