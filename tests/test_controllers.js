'use strict';

var steed = require('steed')();
var should = require('should');
var dynamoose = require('dynamoose');
var proxyquire = require('proxyquire').noPreserveCache();

// Use local instance of dynamodb (must run on port 8000)
dynamoose.AWS.config.update({
  accessKeyId: 'AKID',
  secretAccessKey: 'SECRET',
  region: 'us-east-1'
});
dynamoose.local();

var tb = {
  datasetTableName: 'cumulus_test_controllers_datasets',
  granulesTablePrefix: 'cumulus_test_controllers_granules_'
};

var mockTable = {
  './tables': tb
};

var cont = proxyquire('../src/controllers', mockTable);
var models = require('../src/models');

var wwlln = proxyquire('../src/pipeline/wwlln', {});
var fixtures = proxyquire('../src/fixtures', mockTable);

describe('Test controllers', function () {
  this.timeout(10000);

  var Dataset;
  var GranulesWWLN;
  var testDataSetRecord = 'wwlln';

  var sampleGranule = {
    'lastModified': 1438142400,
    'name': 'AE20140901.Cristobal.loc',
    'sourceFiles': [
      'ftp://hs3.nsstc.nasa.gov/pub/hs3/wwlln/data/txt/Cristobal/AE20140901.Cristobal.loc'
    ],
    'sourceS3Uris': [
      's3://cumulus-source/source-data/wwlln/AE20140901.Cristobal.loc'
    ],
    'waitForPipelineSince': 1471460282
  };

  before(function (done) {
    // Create the tables
    fixtures.populateDataSets(null, function (err) {
      should.not.exist(err);
      Dataset = dynamoose.model(tb.datasetTableName, models.dataSetSchema, {create: true});
      GranulesWWLN = dynamoose.model(tb.granulesTablePrefix + 'wwlln', models.granuleSchema, {create: true});
      var newGranule = new GranulesWWLN(sampleGranule);
      newGranule.save(function () {
        done();
      });
    });
  });

  describe('Test dataset controllers', function () {
    it('should list all datasets', function (done) {
      cont.listDataSets({}, function (err, datasets) {
        should.not.exist(err);
        should.equal(datasets.length, 2);
        should.equal(datasets[1].name, testDataSetRecord);
        done();
      });
    });

    it('should return a particular dataset', function (done) {
      cont.getDataSet({
        path: {
          short_name: testDataSetRecord
        }
      }, function (err, dataset) {
        should.not.exist(err);
        dataset.should.be.instanceOf(Object);
        should.equal(dataset.name, testDataSetRecord);
        done();
      });
    });

    it('should return nothing', function (done) {
      cont.getDataSet({
        path: {
          short_name: 'something'
        }
      }, function (err, dataset) {
        err.should.equal('Record was not found');
        done();
      });
    });

    it('should add one record', function (done) {
      wwlln.name = 'wwlln2';

      cont.postDataSet({
        body: wwlln,
        headers: {
          Token: 'thisisatesttoken'
        }
      }, function (err, dataset) {
        should.not.exist(err);
        dataset.should.equal(wwlln);
        done();
      });
    });

    it('should have three records', function (done) {
      cont.listDataSets({}, function (err, datasets) {
        should.not.exist(err);
        should.equal(datasets.length, 3);
        done();
      });
    });
  });

  describe('Test granules controllers', function () {
    it('should list all datasets', function (done) {
      cont.listGranules({
        path: {
          dataSet: 'wwlln'
        }
      }, function (err, granules) {
        should.not.exist(err);
        should.equal(granules.length, 1);
        should.equal(granules[0].name, sampleGranule.name);
        done();
      });
    });

    it('should return error if wrong dataset name is provided', function (done) {
      cont.listGranules({
        path: {
          dataSet: 'wwlln2222'
        }
      }, function (err, granules) {
        err.should.be.equal('Requested dataset (wwlln2222) doesn\'t exist');
        done();
      });
    });

    it('should get a particular granule', function (done) {
      cont.getGranules({
        path: {
          dataSet: 'wwlln',
          granuleName: sampleGranule.name
        }
      }, function (err, granule) {
        should.not.exist(err);
        granule.name.should.be.equal(sampleGranule.name);
        done();
      });
    });

    it('should return error when particular granule is not found', function (done) {
      cont.getGranules({
        path: {
          dataSet: 'wwlln',
          granuleName: 'something'
        }
      }, function (err, granule) {
        err.should.be.equal('Record was not found');
        done();
      });
    });
  });

  after(function (done) {
    steed.parallel([
      function (cb) {
        Dataset.$__.table.delete(function (err) {
          should.not.exist(err);
          cb(err);
        });
      }, function (cb) {
        GranulesWWLN.$__.table.delete(function (err) {
          should.not.exist(err);
          cb(err);
        });
      }
    ], function (err) {
      done(err);
    });
  });
});
