'use strict';

import { SQS } from 'cumulus-common/aws-helpers';
import _ from 'lodash';
import { localRun } from 'cumulus-common/local';
import { Granule, Collection, Pdr, RecordDoesNotExist } from 'cumulus-common/models';
import { syncUrl, downloadS3Files, fileNotFound } from 'gitc-common/aws';
import Crawler from 'simplecrawler';
import url from 'url';
import log from 'cumulus-common/log';
import pvl from 'pvl';
import path from 'path';
import fs from 'fs';


/**
 * discovers PDR names with a given url and returns
 * a list of PDRs
 * @param {string} endpoint url to the folder where PDRs are listed:
 * @return {Promise} on success the promise includes a list {@link pdrObject|pdrObjects}
 */
export function discoverPDRs(endpoint) {
  const pattern = /<a href="(*.PDR)">/;
  const c = new Crawler(endpoint);

  c.interval = 0;
  c.maxConcurrency = 10;
  c.respectRobotsTxt = false;
  c.userAgent = 'Cumulus';
  c.maxDepth = 1;

  return new Promise((resolve) => {
    c.on('fetchcomplete', (queueItem, responseBuffer) => {
      log.info(`Received the list of PDRs from ${endpoint}`);
      const lines = responseBuffer.toString().trim().split('\n');
      const pdrs = [];
      for (const line of lines) {
        const split = line.trim().split(pattern);
        if (split.length === 3) {
          const name = split[1];
          pdrs.push({
            name: name,
            url: url.resolve(endpoint + '/', name)
          });
        }
      }
      resolve(pdrs);
    });

    c.start();
  });
}


/**
 * Uploads a file from a given URL if file is not found on S3
 *
 * @param {string} originalUrl URL of the file that has to be uploaded
 * @param {string} bucket AWS S3 bucket name
 * @param {string} fileName name of the file
 * @param {string} [key=''] s3 folder name(s)
 * @returns {boolean} true if uploaded / false if not
 */
export async function uploadIfNotFound(originalUrl, bucket, fileName, key = '') {
  const fullKey = path.join(key, fileName);
  // check if the file is already uploaded to S3
  const notFound = await fileNotFound(bucket, fileName, key);
  if (notFound) {
    log.info(`Uploading ${fileName} to S3`);
    await syncUrl(originalUrl, bucket, fullKey);
    log.info(`${fileName} uploaded`);
    return true;
  }
  log.info(`${fileName} is already ingested`);
  return false;
}


/**
 * uploads a given PDR to S3 and adds it to DynamoDb and sends it to SQS
 * @param {pdrObject} pdr pdr object
 * @return {undefined}
 */
export async function uploadAddQueuePdr(pdr) {
  await syncUrl(pdr.url, process.env.internal, `pdrs/${pdr.name}`);
  log.info(`Uploaded ${pdr.name} to S3`, pdr.collectionName);

  pdr.s3Uri = `s3://${process.env.internal}/pdrs/${pdr.name}`;

  // add the pdr to the queue
  // (we use queue here because we want to avoid DDOSing
  // providers
  await SQS.sendMessage(process.env.PDRsQueue, pdr);
  log.info(`Added ${pdr.name} to PDR queue`, pdr.collectionName);

  // add the PDR to the table
  const pdrRecord = Pdr.buildRecord(pdr.name, pdr.url);
  pdrRecord.address = pdr.s3Uri;

  const pdrObj = new Pdr();
  await pdrObj.create(pdrRecord);

  log.info(`Saved ${pdr.name} to PDRsTable`, pdr.collectionName);
}


/**
 * This async function parse a PDR stored on S3 and download all the files
 * in the PDR to a staging S3 bucket. The return is void.
 *
 * The function first download the PDR file from an ingest location to local disk.
 * It thn reads the file content and parse it.
 *
 * The function loops through the parsed PDR and identifies granules and associated files
 * in each object. The files are added to a separate queue for download and new granule records
 * are added to the GranuleTable on DynamoDB.
 *
 * @param {pdrObject} pdr the PDR on s3. The PDR must be on cumulus-internal/pdrs folder
 * @return {undefined}
 */
export async function parsePdr(pdr, concurrency = 5) {
  try {
    // validate the argument
    if (!(_.has(pdr, 'name') && _.has(pdr, 'collectionName'))) {
      throw new Error('The argument must have name and collectionName keys');
    }

    log.info(`${pdr.name} downloaded from S3 to be parsed`, pdr.collectionName);
    // first download the PDR
    await downloadS3Files(
      [{ Bucket: process.env.internal, Key: `pdrs/${pdr.name}` }],
      '.'
    );

    // then read the file and and pass it to parser
    const pdrFile = fs.readFileSync(pdr.name);
    const parsed = pvl.pvlToJS(pdrFile.toString());

    // grab the collection
    const c = new Collection();
    const collectionRecord = await c.get({ collectionName: pdr.collectionName });


    // Get all the file groups
    const fileGroups = parsed.objects('FILE_GROUP');

    const promiseList = [];
    let counter = 0;

    const conc = (func) => {
      counter += 1;
      return promiseList.push(func());
    };

    const approximateFileCount = fileGroups.length * fileGroups[0].objects('FILE_SPEC').length;

    // each group represents a Granule record.
    // After adding all the files in the group to the Queue
    // we create the granule record (moment of inception)
    log.info(`There are ${fileGroups.length} granules in ${pdr.name}`, pdr.collectionName);
    log.info(
      `There are approximately ${approximateFileCount} files in ${pdr.name}`,
      pdr.collectionName
    );

    for (const group of fileGroups) {
      // get all the file specs in each group
      const specs = group.objects('FILE_SPEC');

      // Find the granuleId
      // NOTE: In case of Aster, the filenames don't have the granuleId
      // For Aster, we temporarily use the granuleId in the XAR_ENTRY
      // section of the PDR
      const granuleId = group.objects('XAR_ENTRY')[0].get('GRANULE_ID').value;

      // check if there is a granule record already created
      let granuleRecordExists = false;
      let granuleRecord;
      const g = new Granule();
      try {
        granuleRecord = await g.get({
          granuleId: granuleId,
          collectionName: pdr.collectionName
        });

        log.info(`A record for ${granuleId} exists`, pdr.collectionName);
        granuleRecordExists = true;
      }
      catch (e) {
        if (e instanceof RecordDoesNotExist) {
          log.info(`New record for ${granuleId} will be added`, pdr.collectionName);
        }
        else {
          log.info(e, pdr.collectionName);
          throw e;
        }
      }

      const granuleFiles = [];

      // Add eachfile to the Queue to be downloaded
      for (const spec of specs) {
        const directoryId = spec.get('DIRECTORY_ID').value;
        const fileId = spec.get('FILE_ID').value;
        const fileUrl = url.resolve('https://e4ftl01.cr.usgs.gov:40521/', `${directoryId}/${fileId}`);

        // if file is already added to the granule, skip
        if (granuleRecordExists) {
          if (Granule.fileInRecord(fileUrl, 'sipFile', granuleRecord.files)) {
            log.info(`${fileId} is already ingested, skipping!`, granuleId);
            continue;
          }
        }

        const granuleFile = {
          fileUrl,
          fileId,
          concurrency: pdr.concurrency || 1,
          bucket: process.env.internal,
          key: 'staging'
        };

        // list of files for Granule class
        granuleFiles.push({
          file: fileUrl,
          name: fileId,
          type: 'sipFile'
        });

        conc(async () => {
          await SQS.sendMessage(process.env.GranulesQueue, granuleFile);
          log.info(`Added ${fileId} to Granule Queue`, granuleId);
        });
      }

      // build the granule record and add it to the database
      if (!granuleRecordExists) {
        conc(async () => {
          granuleRecord = await Granule.buildRecord(
            pdr.collectionName,
            granuleId,
            granuleFiles,
            collectionRecord
          );

          await g.create(granuleRecord);

          // add the granule to the PDR record
          const p = new Pdr();
          await p.addGranule(pdr.name, granuleId, false);
          log.info(`Added a new granule: ${granuleId}`, pdr.collectionName);
        });
      }

      if (counter > concurrency) {
        counter = 0;
        log.info('Waiting to process the queue', pdr.collectionName);
        await Promise.all(promiseList);
      }
    }

    return true;
  }
  catch (e) {
    log.error(e.message, e.stack);
    return false;
  }
}

/**
 * This is an indefinitely running function the keeps polling
 * the granule SQS queue.
 *
 * After it receives the messages from the queue, xxxxx
 *
 * @param {number} concurrency=1
 * @param {number} visibilityTimeout=200
 * @param {number} [testLoops=-1] number of messages to be processd before quitting (for test)
 */
export async function pollGranulesQueue(
  concurrency = 1,
  visibilityTimeout = 200,
  testLoops = -1
) {
  try {
    while (true) {
      // receive a message
      const messages = await SQS.receiveMessage(
        process.env.GranulesQueue,
        concurrency,
        visibilityTimeout
      );

      // get message body
      if (messages.length > 0) {
        // holds list of parallels downloads
        const downloads = [];

        log.info(`Ingest: ${concurrency} file(s) concurrently`);

        for (const message of messages) {
          const file = message.Body;
          const receiptHandle = message.ReceiptHandle;
          log.info(`Ingesting ${file.fileId}`);
          const func = async () => {
            try {
              await uploadIfNotFound(
                file.fileUrl,
                file.bucket,
                file.fileId,
                file.key
              );
              await SQS.deleteMessage(process.env.GranulesQueue, receiptHandle);
            }
            catch (e) {
              log.error(e, e.stack);
              log.error(`Couldn't ingest ${file.fileId}`);
            }
            return;
          };
          downloads.push(func());
        }

        // wait for concurrent downloads to finish before next loop
        // this is important to manage the memory usage better
        await Promise.all(downloads);
      }
      else {
        log.debug('No new messages in the PDR queue');

        // this prevents the function from running forever in test mode
        if (testLoops === 0) return;
        if (testLoops > 0) testLoops -= 1;
      }
    }
  }
  catch (e) {
    log.error(e, e.stack);
    throw e;
  }
}


/**
 * Polls a SQS queue for PDRs that have to be parsed.
 * The function is recursive and calls itself until terminated
 *
 * It receives the message(s) from PDRsQueue and send each message to `parsePdr` for parsing.
 * After successful execuation of `parsePdr`, the function deletes the message from the queue
 * and moves to the next message.
 *
 * @param {number} [messageNum=1] Number of messages to be retrieved from the queue
 * @param {number} [visibilityTimeout=20] How long the message is removed from the queue
 */
export async function pollPdrQueue(messageNum = 1, visibilityTimeout = 20, concurrency = 5) {
  try {
    // receive a message
    const messages = await SQS.receiveMessage(
      process.env.PDRsQueue,
      messageNum,
      visibilityTimeout
    );


    // get message body
    if (messages.length > 0) {
      for (const message of messages) {
        const pdr = message.Body;
        const receiptHandle = message.ReceiptHandle;

        log.info(`Parsing ${pdr.name}`, pdr.collectionName);

        const parsed = await parsePdr(pdr, concurrency);

        // detele message if parse successful
        if (parsed) {
          log.info(`deleting ${pdr.name} from the Queue`, pdr.collectionName);
          await SQS.deleteMessage(process.env.PDRsQueue, receiptHandle);
        }
        else {
          log.error(`Parsing failed for ${pdr.name}`, pdr.collectionName);
        }
      }
    }
    else {
      log.debug('No new messages in the PDR queue');
    }
  }
  catch (e) {
    log.error(e);
    throw e;
  }
  finally {
    // make the function recursive
    pollPdrQueue();
  }
}


/**
 * Handler for starting a SQS poll for granules that has to ingested
 * This function runs pollGranulesQueue indefinitely until cancelled
 *
 * @param {object} event AWS Lambda uses this parameter to
 * pass in event data to the handler
 * @return {undefined}
 */
export function ingestGranulesHandler(event) {
  const concurrency = event.concurrency || 1;
  pollGranulesQueue(concurrency);
}


/**
 * Handler for starting a SQS poll for PDRs
 * This function runs pollPdrQueue indefinitely until cancelled
 *
 * @param {object} event AWS Lambda uses this parameter to
 * pass in event data to the handler
 * @return {undefined}
 */
export function parsePdrsHandler(event) {
  const numOfMessage = event.numOfMessage || 1;
  const visibilityTimeout = event.visibilityTimeout || 20;

  pollPdrQueue(numOfMessage, visibilityTimeout);
}


/**
 * Handler for discovering and syncing latest PDRs.
 * The handler is invoked by a Lambda function.
 *
 * The event object (payload) must include the endpoint for the
 * function to check
 * @param {object} event AWS Lambda uses this parameter to
 * pass in event data to the handler
 * @param {object} context
 * {@link http://docs.aws.amazon.com/lambda/latest/dg/nodejs-prog-model-context.html|AWS Lambda's context object}
 * @param {function} cb {@link http://docs.aws.amazon.com/lambda/latest/dg/nodejs-prog-model-handler.html#nodejs-prog-model-handler-callback|AWS Lambda's callback}
 * @return {undefined}
 */
export async function discoverPdrHandler(event, context, cb = () => {}) {
  const func = async () => {
    // get the collectionName
    if (!event.hasOwnProperty('collectionName')) {
      const e = new Error('you must provide collectionName in the event obj');
      throw e;
    }
    const collectionName = event.collectionName;
    log.info('discoverPdrHandler invoked', collectionName);

    // grab collectionName from the database
    const c = new Collection();
    const collection = await c.get({ collectionName: collectionName });

    // get the endpoint from collection
    if (collection.ingest.type !== 'PDR') {
      const e = new Error('This handler only supports PDR ingest');
      log.error(e, collectionName);
      throw e;
    }

    const endpoint = collection.ingest.config.endpoint;
    const concurrency = collection.ingest.config.concurrency || 1;
    log.info(`checking ${endpoint}`, collectionName);

    // discover the PDRs
    const pdrs = await discoverPDRs(endpoint);
    log.info(`Discovered ${pdrs.length} PDRs`, collectionName);
    for (const pdr of pdrs) {
      // check if the PDR is in the database, if not add it and download
      // Note: if a PDR is already download but missing from the database, it will be
      // redownloaded
      const p = new Pdr();
      try {
        await p.get({ pdrName: pdr.name });
        log.info(`${pdr.name} is already ingested`, collectionName);
      }
      catch (e) {
        if (e instanceof RecordDoesNotExist) {
          pdr.concurrency = concurrency;
          pdr.collectionName = collectionName;

          log.info(`Found new PDR ${pdr.name}`, collectionName);
          await uploadAddQueuePdr(pdr);
        }
      }
    }
    const msg = `All PDRs ingested on ${Date()} for this endpoint: ${endpoint}`;
    log.info(msg, collectionName);
    return msg;
  };

  // use callback with promise
  func().then(r => cb(null, r)).catch((err) => {
    log.info(err, JSON.stringify(event));
    cb(err);
  });
}


// for local run: babel-node lambdas/pdr/index.js local
localRun(() => {
  //discoverPdrHandler({ collectionName: 'ASTER_1A_versionId_1' }, null, (d) => console.log(d));

  //pollPdrQueue(1, 10000, 15);

  parsePdr({
    name: 'PDN.ID1701141200.PDR',
    url: 's3://cumulus-internal/pdrs/PDN.ID1701141200.PDR',
    collectionName: 'ASTER_1A_versionId_1'
  });
  //pollGranulesQueue();
});


/**
 * @typedef {Object} pdrObject
 * @property {string} name pdr name
 * @property {string} url pdr url
 */
