'use strict';

const _ = require('lodash');
const parser = require('cron-parser');
const schedule = require('node-schedule');

/**
 * Wrap the provided action with the instructions to avoid replicated execution.
 *
 * @param  {string}   jobName       The name of the job
 * @param  {Number}   nextExecution The time for the next execution in milliseconds
 * @param  {Function} method        The function to be executed by the job
 * @param  {boolean}  recur         Defined if the job is reucurrent or should execute once
 */
function wrapAction(jobName, nextExecution, method, recur) {
  // Locks so other jobs wait before executing
  this.redisLock(`${jobName}Lock`, (done) => {
    // Gets the job next execution saved on redis
    this.redisClient.get(jobName, (err, reply) => {
      const now = new Date().getTime();
      const savedExecution = Number(reply.toString());

      // If execution is recurrent, verify if current execution is before saved next execution.
      // If not, verify if execution already happened.
      if (_.isNil(reply) || (recur ? savedExecution < now : savedExecution !== nextExecution)) {
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

/**
 * Wrap the provided action with the instructions to avoid replicated execution when using a cron
 * expression.
 *
 * @param  {string}   jobName  The name of the job
 * @param  {string}   cronSpec The cron expression that defines when to execute the job
 * @param  {Function} method   The method the job should execute
 * @return {Function}          The wrapped version of the provided method, that verifies if the
 *                             execution is necessary.
 */
function buildCronAction(jobName, cronSpec, method) {
  return () => {
    const nextExecution = parser.parseExpression(cronSpec).next().getTime();
    wrapAction.bind(this)(jobName, nextExecution, method, true);
  };
}

/**
 * Wrap the provided action with the instructions to avoid replicated execution when using a
 * recurrence rule.
 *
 * @param  {string}         jobName   The name of the job
 * @param  {RecurrenceRule} recurSpec The recurrence rule to execute the job
 * @param  {Function}       method    The method the job should execute
 * @return {Function}                 The wrapped version of the provided method, that verifies if
 *                                    the execution is necessary.
 */
function buildRecurAction(jobName, recurSpec, method) {
  return () => {
    const nextDate = recurSpec.nextInvocationDate();
    nextDate.setMilliseconds(0);
    wrapAction.bind(this)(jobName, nextDate.getTime(), method, recurSpec.recurs);
  };
}

/**
 * Wrap the provided action with the instructions to avoid replicated execution when using a date.
 *
 * @param  {string}   jobName The name of the job
 * @param  {Date}     date    The date to execute the job
 * @param  {Function} method  The method the job should execute
 * @return {Function}         The wrapped version of the provided method, that verifies if the
 *                            execution is necessary.
 */
function buildDateAction(jobName, date, method) {
  return () => {
    wrapAction.bind(this)(jobName, date.getTime(), method, false);
  };
}


/**
 * Main class of the module. Provides method to schedule jobs.
 */
class SyncedScheduler {
  /**
   * Instantiates the scheduler. Receiving the redis client to be used.
   *
   * @param  {RedisClient} client The redis client to be used to save job dates
   */
  constructor(client) {
    this.redisClient = client;
    // Uses the provided client to configure redisLock
    this.redisLock = require('redis-lock')(this.redisClient);  // eslint-disable-line global-require
  }

  /**
   * @param {string}                     jobName The name of the job
   * @param {Date|string|RecurrenceRule} spec    The schedule for the jobs execution
   * @param {function}                   method  The method the job should execute
   * @return {Job}                               An instance of the job, so it can be cancelled
   */
  scheduleJob(jobName, spec, method) {
    let action = method;
    if (typeof spec === 'string') {
      action = buildCronAction.bind(this)(jobName, spec, method);
    }
    if (spec.recurs) {
      action = buildRecurAction.bind(this)(jobName, spec, method);
    }
    if (spec instanceof Date) {
      action = buildDateAction.bind(this)(jobName, spec, method);
    }
    return schedule.scheduleJob(jobName, spec, action);
  }
}

module.exports = SyncedScheduler;
