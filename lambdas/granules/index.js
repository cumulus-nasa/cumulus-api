'use strict';

import _ from 'lodash';
import { localRun } from 'cumulus-common/local';
import { Search } from 'cumulus-common/es/search';

/**
 * List all granules for a given collection.
 * @param {object} event aws lambda event object.
 * @param {object} context aws lambda context object
 * @param {callback} cb aws lambda callback function
 * @return {undefined}
 */
export function list(event, context, cb) {
  const search = new Search(event, process.env.GranulesTable);
  search.query().then((response) => cb(null, response)).catch((e) => {
    cb(e);
  });
}

/**
 * Query a single granule.
 * @param {string} collectionName the name of the collection.
 * @param {string} granuleId the id of the granule.
 * @return {object} a single granule object.
 */
export function get(event, context, cb) {
  const collection = _.get(event.path, 'collection');
  const granuleId = _.get(event.path, 'granuleName');

  if (!collection || !granuleId) {
    return cb('Must supply path.collection and path.granuleName');
  }

  const search = new Search({}, process.env.GranulesTable);
  search.get(`${collection}|${granuleId}`).then((response) => {
    cb(null, response);
  }).catch((e) => {
    cb(e);
  });
}

localRun(() => {
  list({
    //query: { granuleId: '1A0000-2017012301_003_061', collectionName: 'AST_L1A__version__003'}
    query: { sort_by: 'duration', order:'asc' }
  }, null, (e, r) => {
    console.log(r)
    console.log(e)
  });
});
