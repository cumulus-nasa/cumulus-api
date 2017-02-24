'use strict';
import queue from 'queue-async';
import { client as esClient } from 'cumulus-common/es';
import { AttributeValue } from 'dynamodb-data-types';
import { get } from 'lodash';
const unwrap = AttributeValue.unwrap;

const index = process.env.StackName || 'cumulus-local-test';
const type = process.env.ES_TYPE || 'type';
const hash = process.env.DYNAMODB_HASH || 'no-hash-env';
const range = process.env.DYNAMODB_RANGE || 'NONE';


function deleteRecord(params, callback) {
  esClient.get(params, (error, response, status) => {
    if (status !== 200) {
      return callback(null, null);
    }
    esClient.delete(params, (e, r) => {
      if (e) {
        callback(e);
      }
      else {
        callback(null, r);
      }
    });
  });
}

function saveRecord(data, params, callback) {
  esClient.get(params, (error, response, status) => {
    if (status !== 200 && status !== 404) {
      callback(error);
    }
    const exists = status === 200;

    const h = (e, r, s) => {
      if (s === 200 || s === 201) {
        callback(null, data);
      }
      else {
        callback(e || new Error('Could not write record'));
      }
    };

    if (exists) {
      const update = Object.assign({}, params, {
        body: { doc: data }
      });
      esClient.update(update, h);
    }
    else {
      const create = Object.assign({}, params, {
        body: data
      });
      esClient.create(create, h);
    }
  });
}

function processRecords(event, done) {
  const q = queue();
  const records = get(event, 'Records');
  if (!records) {
    return done(null, 'No records found in event');
  }
  records.forEach((record) => {
    const keys = unwrap(get(record, 'dynamodb.Keys'));
    const hashValue = keys[hash];
    if (hashValue) {
      const id = range === 'NONE' ? hashValue : hashValue + '_' + keys[range];
      const params = { index, type, id };
      if (record.eventName === 'REMOVE') {
        q.defer((callback) => deleteRecord(params, callback));
      }
      else {
        const data = unwrap(record.dynamodb.NewImage);
        q.defer((callback) => saveRecord(data, params, callback));
      }
    }
    else {
      // defer an error'd callback so we can handle it in awaitAll.
      q.defer((callback) =>
        callback(new Error(`Could not find hash value for property name ${hash}`))
      );
    }
  });

  q.awaitAll((error, result) => {
    if (error) {
      done(null, error.message);
    }
    else {
      done(null, `Records altered: ${result.filter(Boolean).length}`);
    }
  });
}

/**
 * Sync changes to dynamodb to an elasticsearch instance.
 * Sending updates to this lambda is handled by automatically AWS.
 * @param {array} Records list of records with an eventName property signifying REMOVE or INSERT.
 * @return {string} response text indicating the number of records altered in elasticsearch.
 */
export function handler(event, context, done) {
  console.log(JSON.stringify(event));
  esClient.indices.exists({ index }, (error, response, status) => {
    if (status === 404) {
      esClient.indices.create({ index }, (e) => {
        if (e) {
          done(null, e.message);
        }
        else {
          processRecords(event, done);
        }
      });
    }
    else if (status === 200) {
      processRecords(event, done);
    }
    else {
      done(null, error.message);
    }
  });
}
