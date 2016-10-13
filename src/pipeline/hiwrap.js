'use strict';

var recipe = {
  resource: 'group',
  name: 'WorkerGroup',
  steps: [{
    type: 'archive',
    name: 'Fetch',
    action: 'download'
  }, {
    type: 'runner',
    name: 'Process',
    image: '985962406024.dkr.ecr.us-east-1.amazonaws.com/cumulus-hs3-hiwrap:latest',
    after: 'Fetch'
  }, {
    type: 'metadata',
    name: 'Metadata',
    after: 'Process'
  }, {
    type: 'archive',
    name: 'Upload',
    action: 'upload',
    after: 'Metadata'
  }, {
    type: 'cleanup',
    after: 'Upload'
  }]
};

var datasetRecord = {
  name: 'hiwrap',
  shortName: 'hs3hiwrap',
  versionId: 1,
  daacName: 'Global Hydrology Resource Center DAAC',
  sourceDataBucket: {
    bucketName: 'cumulus-ghrc-raw',
    prefix: 'hiwrap/',
    granulesFiles: 1,
    format: '.nc'
  },
  destinationDataBucket: {
    bucketName: 'cumulus-ghrc-archive',
    prefix: 'hs3hiwrap/',
    granulesFiles: 1,
    format: '.nc'
  },
  dataPipeLine: {
    recipe: recipe,
    batchLimit: 10
  }
};

module.exports = datasetRecord;
