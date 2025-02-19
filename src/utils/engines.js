import {v4 as uuidv4} from 'uuid';

import {
  convertProcessedImage,
  getMaxImageUploadSize,
  getLargeImageMessage,
  sendLargeMessage
} from 'utils/app';
import {
  dataUrlToBlob,
  waitForDocumentLoad,
  executeScriptMainContext
} from 'utils/common';

function getValidHostname(validHostnames, engine) {
  const hostname = window.location.hostname;
  if (!validHostnames.includes(hostname)) {
    throw new Error(`Invalid ${engine} hostname: ${hostname}`);
  }
  return hostname;
}

async function setFileInputData(
  selector,
  input,
  image,
  {patchInput = false} = {}
) {
  if (patchInput) {
    const eventName = uuidv4();

    await executeScriptMainContext({
      func: 'setFileInputData',
      args: [eventName]
    });

    document.dispatchEvent(
      new CustomEvent(eventName, {
        detail: JSON.stringify({
          selector,
          imageDataUrl: image.imageDataUrl,
          imageFilename: image.imageFilename,
          imageType: image.imageType
        })
      })
    );
  } else {
    const fileData = new File([image.imageBlob], image.imageFilename, {
      type: image.imageType
    });

    const dt = new DataTransfer();
    dt.items.add(fileData);

    input.files = dt.files;
  }
}

function showEngineError({message, errorId, engine}) {
  if (!message) {
    message = browser.i18n.getMessage(
      errorId,
      browser.i18n.getMessage(`engineName_${engine}`)
    );
  }

  browser.runtime.sendMessage({
    id: 'notification',
    message,
    type: `${engine}Error`
  });
}

function uploadCallback(xhr, callback, engine) {
  try {
    callback(xhr);
  } catch (err) {
    showEngineError({errorId: 'error_engine', engine});

    console.log(err.toString());
    throw err;
  }
}

async function sendReceipt(storageIds) {
  if (storageIds.length) {
    const keys = [...storageIds];
    while (storageIds.length) {
      storageIds.pop();
    }

    await browser.runtime.sendMessage({
      id: 'storageReceipt',
      storageIds: keys
    });
  }
}

async function initSearch(searchFn, engine, taskId) {
  await waitForDocumentLoad();

  const task = await browser.runtime.sendMessage({
    id: 'storageRequest',
    asyncResponse: true,
    storageId: taskId
  });

  if (task) {
    const storageIds = [taskId, task.imageId];

    try {
      let image = await sendLargeMessage({
        message: {
          id: 'storageRequest',
          asyncResponse: true,
          storageId: task.imageId
        },
        transferResponse: true
      });

      if (image) {
        if (task.search.assetType === 'image') {
          image = await prepareImageForUpload({image, engine});
        }

        await searchFn({
          session: task.session,
          search: task.search,
          image,
          storageIds
        });
      } else {
        await sendReceipt(storageIds);

        showEngineError({errorId: 'error_sessionExpiredEngine', engine});
      }
    } catch (err) {
      await sendReceipt(storageIds);

      const params = {engine};
      if (err.name === 'EngineError') {
        params.message = err.message;
      } else {
        params.errorId = 'error_engine';
      }

      showEngineError(params);

      console.log(err.toString());
      throw err;
    }
  } else {
    showEngineError({errorId: 'error_sessionExpiredEngine', engine});
  }
}

async function searchPinterest({session, search, image} = {}) {
  const data = new FormData();
  data.append('image', image.imageBlob, image.imageFilename);
  data.append('x', '0');
  data.append('y', '0');
  data.append('w', '1');
  data.append('h', '1');
  data.append('base_scheme', 'https');

  const rsp = await fetch(
    'https://api.pinterest.com/v3/visual_search/extension/image/',
    {
      referrer: '',
      mode: 'cors',
      method: 'PUT',
      body: data
    }
  );

  const response = await rsp.json();

  if (
    rsp.status !== 200 ||
    response.status !== 'success' ||
    !response.data ||
    !response.data.length
  ) {
    throw new Error('search failed');
  }

  const results = response.data.map(item => ({
    page: `https://pinterest.com/pin/${item.id}/`,
    image: item.image_large_url,
    text: item.description
  }));

  return results;
}

class EngineError extends Error {
  constructor(message) {
    super(message);
    this.name = 'EngineError';
  }
}

async function prepareImageForUpload({
  image,
  engine,
  target,
  newType = '',
  setBlob = true
} = {}) {
  const maxSize = getMaxImageUploadSize(engine, {target});

  if (maxSize) {
    if (image.imageSize > maxSize) {
      image = await convertProcessedImage(image, {newType, maxSize, setBlob});

      if (!image) {
        throw new EngineError(getLargeImageMessage(engine, maxSize));
      }
    } else {
      if (setBlob) {
        image.imageBlob = dataUrlToBlob(image.imageDataUrl);
      }
    }
  }

  return image;
}

export {
  getValidHostname,
  setFileInputData,
  showEngineError,
  uploadCallback,
  sendReceipt,
  initSearch,
  searchPinterest,
  EngineError,
  prepareImageForUpload
};
