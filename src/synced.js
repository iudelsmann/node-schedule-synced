'use strict';

const _ = require('lodash');
const parser = require('cron-parser');
const schedule = require('node-schedule');

function wrapAction(jobName, nextExecution, method) {
  // Locks so other jobs wait before executing
  this.redisLock(`${jobName}Lock`, (done) => {
    // Gets the job next execution saved on redis
    this.redisClient.get(jobName, (err, reply) => {
      const now = new Date().getTime();

      if (_.isNil(reply) || reply.toString() < now) {
        // Sets the next execution time on redis so other jobs wont run
        this.redisClient.set(jobName, nextExecution, () => {
          // Releases the lock since it is no longer required
          done();
          // Calls the method passed by the user
          try {
            method();
          } catch (error) {
            // this.logger.error(error);
          }
        });
      } else {
        done();
      }
    });
  });
}

function buildCronAction(jobName, cronSpec, method) {
  return () => {
    const nextExecution = parser.parseExpression(cronSpec).next().getTime();
    wrapAction.bind(this)(jobName, nextExecution, method);
  };
}

function buildRecurAction(jobName, recurSpec, method) {
  return () => {
    const nextDate = recurSpec.nextInvocationDate();
    nextDate.setMilliseconds(0);
    const nextExecution = nextDate.getTime();
    wrapAction.bind(this)(jobName, nextExecution, method);
  };
}


class SyncedScheduler {
  constructor(client) {
    this.redisClient = client;
    // Uses the provided client to configure redisLock
    this.redisLock = require('redis-lock')(this.redisClient);  // eslint-disable-line global-require
    // Initialize jobs list
    this.jobs = {};
  }

  scheduleJob(jobName, spec, method, callback) {
    let action = method;
    if (typeof spec === 'string') {
      action = buildCronAction.bind(this)(jobName, spec, method);
    }
    if (spec.recurs) {
      action = buildRecurAction.bind(this)(jobName, spec, method);
    }
    return schedule.scheduleJob(jobName, spec, action, callback);
  }
}

module.exports = SyncedScheduler;
