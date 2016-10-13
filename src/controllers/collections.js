'use strict';

var _ = require('lodash');
var dynamoose = require('dynamoose');
var schemas = require('../models/schemas');
var tb = require('../models/tables');
var es = require('../es');

var parseRecipe = function (record) {
  if (_.has(record, 'dataPipeLine.recipe')) {
    record.dataPipeLine.recipe = JSON.parse(record.dataPipeLine.recipe);
  }
  return record;
};

module.exports.list = function (req, cb) {
  es.esQuery({
    query: {
      match: { _index: tb.datasetTableName }
    }
  }, (err, res) => {
    res = res.map(function (r) {
      return parseRecipe(r);
    });

    return cb(err, res);
  });
};

module.exports.get = function (req, cb) {
  es.esQuery({
    query: {
      bool: {
        must: [
          { match: { _index: tb.datasetTableName } },
          { match: { name: req.path.short_name } }
        ]
      }
    }
  }, (err, res) => {
    if (err) { return cb(err); }

    // Cannot have more than 1 document, because `name` is the primary Dynamo key
    if (res.length === 0) {
      return cb('Record was not found');
    } else {
      return cb(null, parseRecipe(res[0]));
    }
  });
};

module.exports.post = function (req, cb) {
  var Dataset = dynamoose.model(tb.datasetTableName, schemas.dataSetSchema, {create: false});

  var postedRecord = _.get(req, 'body', {});

  Dataset.get({name: postedRecord.name}, function (err, collection) {
    if (err) {
      return cb(err);
    }
    if (!collection) {
      var newRecord = new Dataset(postedRecord);
      newRecord.save(function (err) {
        return cb(err, postedRecord);
      });
    } else {
      return cb('Record already exists');
    }
  });
};

module.exports.put = function (req, cb) {
  var Dataset = dynamoose.model(tb.datasetTableName, schemas.dataSetSchema, {create: false});

  var postedRecord = _.get(req, 'body', {});
  var name = postedRecord.name;
  var update = _.omit(postedRecord, ['name']);

  Dataset.get(name, function (err, collection) {
    if (err) {
      return cb(err);
    }

    if (collection) {
      Dataset.update(name, update, function (err, updatedCollection) {
        if (err) {
          return cb(err);
        }
        cb(err, updatedCollection);
      });
    } else {
      return cb('Record was not found!');
    }
  });
};
