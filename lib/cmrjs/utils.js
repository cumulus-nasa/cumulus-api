import got from 'got';
import publicIp from 'public-ip';
import xml2js from 'xml2js';
import secrets from '../../config/secrets.json';

function getHost() {
  const env = process.env.CMR_ENVIRONMENT;
  let host;

  if (env === 'OPS') {
    host = 'cmr.earthdata.nasa.gov';
  }
  else if (env === 'SIT') {
    host = 'cmr.sit.earthdata.nasa.gov';
  }
  else {
    host = 'cmr.uat.earthdata.nasa.gov';
  }

  return host;
}


export const xmlParseOptions = {
  ignoreAttrs: true,
  mergeAttrs: true,
  explicitArray: false
};


export function getUrl(type, cmrProvider) {
  let url;
  const host = getHost();
  const env = process.env.CMR_ENVIRONMENT;
  const provider = cmrProvider || secrets.CMR_PROVIDER;

  switch (type) {
    case 'token':
      if (env === 'OPS') {
        url = 'https://api.echo.nasa.gov/echo-rest/tokens/';
      }
      else if (env === 'SIT') {
        url = 'https://testbed.echo.nasa.gov/echo-rest/tokens/';
      }
      else {
        url = 'https://api-test.echo.nasa.gov/echo-rest/tokens/';
      }
      break;
    case 'search':
      url = `https://${host}/search/`;
      break;
    case 'validate':
      url = `https://${host}/ingest/providers/${provider}/validate/`;
      break;
    case 'ingest':
      url = `https://${host}/ingest/providers/${provider}/`;
      break;
    default:
      url = null;
  }

  return url;
}


export async function validate(type, xml, identifier, token) {
  if (identifier === undefined) {throw new Error(`The field GranuleUR is not defined in the metadata`);}

  const result = await got.post(`${getUrl('validate')}${type}/${identifier}`, {
    body: xml,
    headers: {
      'Echo-Token': token,
      'Content-type': 'application/echo10+xml'
    }
  });

  if (result.statusCode === 200) {
    return true;
  }

  const parsed = await new Promise((resolve, reject) => {
    xml2js.parseString(result.body, xmlParseOptions, (err, res) => {
      if (err) reject(err);
      resolve(res);
    });
  });

  throw new Error(
    `Validation was not successful, CMR error message: ${JSON.stringify(parsed.errors.error)}`
  );
}


export async function updateToken(cmrProvider, clientId, username, password) {
  // Update the saved ECHO token
  // for info on how to add collections to CMR: https://cmr.earthdata.nasa.gov/ingest/site/ingest_api_docs.html#validate-collection
  const ip = await publicIp.v4();

  const tokenData = {
    token: {
      username: username || secrets.CMR_USERNAME,
      password: password || secrets.CMR_PASSWORD,
      client_id: clientId || secrets.CMR_CLIENT_ID,
      user_ip_address: ip,
      provider: cmrProvider || secrets.CMR_PROVIDER
    }
  };

  const builder = new xml2js.Builder();
  const xml = builder.buildObject(tokenData);

  let resp = await got.post(getUrl('token'), {
    body: xml,
    headers: { 'Content-Type': 'application/xml' }
  });

  resp = await new Promise((resolve, reject) => {
    xml2js.parseString(resp.body, xmlParseOptions, (err, response) => {
      if (err) reject(err);
      resolve(response);
    });
  });

  if (!resp.token) {
    throw new Error('Authentication with CMR failed');
  }
  return resp.token.id;
}

export async function tokenIsValid(token) {
  // Use a fake collection ID and fake PUT data to see if the token is still valid
  const resp = await got.put(
    `${getUrl('ingest')}collections/CMRJS_TOKEN_TEST`,
    {
      body: null,
      headers: {
        'Echo-Token': token,
        'Content-type': 'application/echo10+xml'
      }
    }
  );

  const body = resp.body;
  if (body.toLowerCase().includes('token') ||
      body.toLowerCase().includes('expired') ||
      body.toLowerCase().includes('permission')) {
    return false;
  }

  return true;
}
