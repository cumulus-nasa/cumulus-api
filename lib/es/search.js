/* This code is copied from sat-api-lib library
 * with some alterations.
 * source: https://raw.githubusercontent.com/sat-utils/sat-api-lib/master/libs/search.js
 */
'use strict';

import _ from 'lodash';
import aws from 'aws-sdk';
import httpAwsEs from 'http-aws-es';
import elasticsearch from 'elasticsearch';
import log from '../log';
import queries from './queries';
import { date, term } from './aggregations';

const logDetails = {
  file: 'lib/es/search.js',
  type: 'apigateway'
};

export class Search {
  static es() {
    let credentials;
    let esConfig;

    // this is needed for getting temporary credentials from IAM role
    if (process.env.MODE === 'local') {
      esConfig = {
        host: 'localhost:9200'
      };
    }
    else {
      if (process.env.MODE === 'remote') {
        credentials = new aws.Credentials(
          process.env.AWS_ACCESS_KEY_ID,
          process.env.AWS_SECRET_ACCESS_KEY
        );
      }
      else {
        credentials = new aws.EnvironmentCredentials('AWS');
      }

      esConfig = {
        host: process.env.ES_HOST || 'localhost:9200',
        connectionClass: httpAwsEs,
        amazonES: {
          region: process.env.AWS_DEFAULT_REGION || 'us-east-1',
          credentials
        },

        // Note that this doesn't abort the query.
        requestTimeout: 50000  // milliseconds
      };
    }

    return new elasticsearch.Client(esConfig);
  }

  constructor(event, type = null) {
    let params;

    this.type = type;

    this.client = this.constructor.es();

    log.debug('received query:', event.query, logDetails);
    log.debug('received body:', event.body, logDetails);

    // this will allow us to receive payload
    // from GET and POST requests
    if (_.has(event, 'query') && !_.isEmpty(event.query)) {
      params = event.query;
    }
    else if (_.has(event, 'body') && !_.isEmpty(event.body)) {
      params = event.body;
    }
    else {
      params = {};
    }

    // get page number
    const page = parseInt((params.page) ? params.page : 1);
    this.params = params;
    log.debug('Generated params:', params, logDetails);

    this.size = parseInt((params.limit) ? params.limit : 1);
    this.frm = (page - 1) * this.size;
    this.page = parseInt((params.skip) ? params.skip : page);
    this.index = process.env.StackName || 'cumulus-local-test';
  }

  _buildSearch() {
    let fields;

    // if fields are included remove it from params
    if (_.has(this.params, 'fields')) {
      fields = this.params.fields;
      this.params = _.omit(this.params, ['fields']);
    }

    return {
      index: this.index,
      body: queries(this.params),
      size: this.size,
      from: this.frm,
      type: this.type,
      _source: fields
    };
  }

  _buildAggregation() {
    const aggrs = { aggs: {} };

    if (_.has(this.params, 'fields')) {
      const fields = this.params.fields.split(',');

      _.forEach(fields, (field) => {
        if (field === 'createdAt') {
          aggrs.aggs = _.assign(aggrs.aggs, date(field));
        }
        else {
          aggrs.aggs = _.assign(aggrs.aggs, term(field));
        }
      });

      this.params = _.omit(this.params, ['fields']);
    }

    return {
      index: this.index,
      body: _.assign({}, aggrs, queries(this.params)),
      type: this.type,
      size: 0
    };
  }

  _metaTemplate() {
    return {
      name: 'cumulus-api',
      table: this.type
    };
  }

  async get(id) {
    try {
      const result = await this.client.get({
        index: this.index,
        type: this.type,
        id: id
      });

      return result._source;
    }
    catch (e) {
      if (_.has(e, 'displayName') && e.displayName === 'NotFound') {
        return { detail: 'Record not found' };
      }
      log.error(e, logDetails);
      throw e;
    }
  }

  async query() {
    const searchParams = this._buildSearch();

    try {
      // search ES with the generated parameters
      const result = await this.client.search(searchParams);

      const count = result.hits.total;
      const response = result.hits.hits.map((s) => s._source);

      const meta = this._metaTemplate();
      meta.limit = this.size;
      meta.page = this.page;
      meta.count = count;

      return {
        meta,
        results: response
      };
    }
    catch (e) {
      log.error(e, logDetails);
      return e;
    }
  }

  async count() {
    const searchParams = this._buildAggregation();

    try {
      const result = await this.client.search(searchParams);
      const count = result.hits.total;

      return {
        meta: {
          found: count,
          name: 'cumulus-api'
        },
        counts: result.aggregations
      };
    }
    catch (e) {
      log.error(e, logDetails);
      return e;
    }
  }
}
