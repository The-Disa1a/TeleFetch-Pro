// Core Telegram Downloader Logic 
// Runs in the PAGE context to access Blob URLs successfully.

const contentRangeRegex = /^bytes (\d+)-(\d+)\/(\d+)$/;

function formatFileName(baseName, mimeType, defaultExt = 'mp4') {
    let ext = defaultExt;
    if (mimeType) {
        let mimePart = mimeType.split(';')[0];
        if (mimePart && mimePart.includes('/')) {
            ext = mimePart.split('/')[1];
        }
    }
    ext = ext.toLowerCase();
    if (ext === 'jpeg') ext = 'jpg';
    if (ext === 'quicktime') ext = 'mov';
    
    // Check if the baseName already ends with this exact extension
    if (!baseName.toLowerCase().endsWith('.' + ext)) {
        return baseName + '.' + ext;
    }
    return baseName;
}

let abortControllers = {};

document.addEventListener('media_cancel_download', function(e) {
    const id = e.detail.video_id;
    if (abortControllers[id]) {
        abortControllers[id].abort();
        delete abortControllers[id];
    }
});

document.addEventListener('media_download_event', function (e) {
  if (e.detail.type == 'single') {
    handleFetchDownload(e.detail.video_src.video_url, e.detail.video_src.video_id, e.detail.title, e.detail.is_resume);
  } else if (e.detail.type == 'batch') {
    let video_list = e.detail.video_src;
    for (let i = 0; i < video_list.length; i++) {
      handleFetchDownload(video_list[i].video_url, video_list[i].video_id, video_list[i].title, e.detail.is_resume);
    }
  }
});

function reportProgress(id, prog) {
    document.dispatchEvent(new CustomEvent(id + '_download_progress', { detail: prog }));
}

const tel_download_video = (url, id = '', providedTitle, isResume = false) => {
  let _blobs = [];
  let _next_offset = 0;
  let _total_size = null;
  let fileName = providedTitle ? providedTitle : (Math.random() + 1).toString(36).substring(2, 10);
  try {
    const metadata = JSON.parse(decodeURIComponent(url.split('/')[url.split('/').length - 1]));
    if (metadata.fileName && !providedTitle) {
      fileName = metadata.fileName;
    }
  } catch (e) {}

  fileName = formatFileName(fileName, "", "mp4");

  if (isResume && window._tele_states && window._tele_states[id]) {
      _blobs = window._tele_states[id].blobs;
      _next_offset = window._tele_states[id].next_offset;
      _total_size = window._tele_states[id].total_size;
      fileName = window._tele_states[id].fileName;
      console.log(`[Telegram Downloader] Resuming from offset ${_next_offset} bytes...`);
  }

  console.log(`[Telegram Downloader] Attempting to download starting URL: ${url}`);
  const controller = new AbortController();
  abortControllers[id] = controller;

  let isPaused = false;
  let isAborted = false;

  const pauseHandler = (e) => { 
      if (e.detail.video_id === id) { 
          isPaused = true; 
          window._tele_states = window._tele_states || {};
          window._tele_states[id] = {
              blobs: _blobs,
              next_offset: _next_offset,
              total_size: _total_size,
              fileName: fileName
          };
          controller.abort(); 
      } 
  };
  const resumeHandler = (e) => { 
      if (e.detail.video_id === id) { 
          isPaused = false; 
          fetchNextPart(); 
      } 
  };
  const cancelHandler = (e) => { 
      if (e.detail.video_id === id) { 
          isAborted = true; 
          controller.abort(); 
      } 
  };
  
  document.addEventListener('media_pause_download', pauseHandler);
  document.addEventListener('media_resume_download', resumeHandler);
  document.addEventListener('media_cancel_download', cancelHandler);
  
  const cleanup = () => {
      document.removeEventListener('media_pause_download', pauseHandler);
      document.removeEventListener('media_resume_download', resumeHandler);
      document.removeEventListener('media_cancel_download', cancelHandler);
      delete abortControllers[id];
  };

  const fetchNextPart = () => {
    fetch(url, {
      method: 'GET',
      headers: {
        Range: `bytes=${_next_offset}-`,
      },
      signal: controller.signal
    })
      .then((res) => {
        if (![200, 206].includes(res.status)) {
          throw new Error('Non 200/206 response was received: ' + res.status);
        }
        
        try {
            const contentTypeStr = res.headers.get('Content-Type');
            // If the chunk is actually an HTML page, the stream has been revoked or redirected (due to concurrency)
            if (contentTypeStr && contentTypeStr.includes('text/html')) {
                throw new Error('Received HTML instead of media. Stream revoked.');
            }
            
            let baseName = providedTitle;
            if (!baseName && fileName.includes('.')) {
                // Strip the temporary .mp4 we appended earlier
                baseName = fileName.substring(0, fileName.lastIndexOf('.'));
            }
            if (!baseName) baseName = fileName;
            
            fileName = formatFileName(baseName, contentTypeStr, 'mp4');
        } catch(e) {
             if (e.message && e.message.includes('Stream revoked')) {
                 throw e;
             }
        }

        const contentRange = res.headers.get('Content-Range');
        if (!contentRange) {
           return res.blob().then((resBlob) => {
               _blobs.push(resBlob);
               _total_size = resBlob.size;
               _next_offset = _total_size;
               reportProgress(id, "100.00");
               save();
           });
        }

        const match = contentRange.match(contentRangeRegex);
        if (match) {
            const startOffset = parseInt(match[1]);
            const endOffset = parseInt(match[2]);
            const totalSize = parseInt(match[3]);

            if (startOffset !== _next_offset) {
              throw 'Gap detected between responses.';
            }
            if (_total_size && totalSize !== _total_size) {
              throw 'Total size differs';
            }

            _next_offset = endOffset + 1;
            _total_size = totalSize;
            
            return res.blob().then((resBlob) => {
                _blobs.push(resBlob);
                
                let prog = ((_next_offset / _total_size) * 100).toFixed(2);
                reportProgress(id, prog);

                if (_next_offset < _total_size) {
                    if (!isPaused && !isAborted) {
                        fetchNextPart();
                    }
                } else {
                    save();
                }
            });
        }
      })
      .catch((reason) => {
        if (reason.name === 'AbortError' || isAborted || isPaused) {
             if (isPaused) {
                 console.log('[Telegram Downloader] Download paused');
                 reportProgress(id, 'paused');
             } else {
                 console.log('[Telegram Downloader] Download aborted');
                 reportProgress(id, 'aborted');
                 if (window._tele_states) delete window._tele_states[id];
             }
        } else {
             console.error('[Telegram Downloader] Error fetching part:', reason);
             reportProgress(id, "error");
        }
        cleanup();
      });
  };

  const save = () => {
    console.log('[Telegram Downloader] Concatenating blobs and downloading...', fileName);
    const blob = new Blob(_blobs, { type: 'video/mp4' });
    const blobUrl = window.URL.createObjectURL(blob);

    const a = document.createElement('a');
    document.body.appendChild(a);
    a.href = blobUrl;
    a.download = fileName;
    a.click();
    document.body.removeChild(a);
    cleanup();
    if (window._tele_states) delete window._tele_states[id];
    console.log('[Telegram Downloader] Download complete.');
    setTimeout(() => {
        window.URL.revokeObjectURL(blobUrl);
    }, 60000);
  };

  fetchNextPart();
};

async function fetchUrl(url) {
  let t = await fetch(url, { headers: { Range: 'bytes=0-' } });
  if (!t.ok) throw Error(`HTTP error! Status: ${t.status}`);
  
  let contentTypeStr = t.headers.get('Content-Type');
  if (contentTypeStr && contentTypeStr.includes('text/html')) {
     throw new Error('Received HTML instead of media. Stream revoked.');
  }
  
  let r = parseInt(t.headers.get('Content-Range').split('/')[1], 10),
    o = parseInt(t.headers.get('Content-Length'), 10),
    n = contentTypeStr,
    s = t.headers.get('Accept-Ranges');
  if ('bytes' !== s) throw Error('Server does not support partial content (byte ranges)');
  return {
    contentType: n,
    segmentCount: Math.ceil(r / o),
    contentSize: r,
    segmentSize: o,
  };
}

async function handleFetchDownload(url, id, providedTitle, isResume = false) {
  if (url.startsWith('blob:')) {
    return tel_download_video(url, id, providedTitle, isResume);
  }
  let isPaused = false;
  let isAborted = false;
  let cleanup = null;
  
  try {
    let { segmentCount: n, segmentSize: c, contentSize: d, contentType: f } = await fetchUrl(url);

      let name = providedTitle || getFileNameFromUrl(url, f);
      if (!name || name.trim() === '') name = `download_${Date.now()}`;
      name = formatFileName(name, f, 'mp4');
      
      const controller = new AbortController();
      abortControllers[id] = controller;

      const pauseHandler = (e) => { 
          if (e.detail.video_id === id) { 
              isPaused = true; 
              controller.abort(); 
          } 
      };
      const cancelHandler = (e) => { 
          if (e.detail.video_id === id) { 
              isAborted = true; 
              controller.abort(); 
          } 
      };
      
      document.addEventListener('media_pause_download', pauseHandler);
      document.addEventListener('media_cancel_download', cancelHandler);
      
      cleanup = () => {
          document.removeEventListener('media_pause_download', pauseHandler);
          document.removeEventListener('media_cancel_download', cancelHandler);
          delete abortControllers[id];
      };

      let progress = Array(n)
          .fill(0)
          .map((e, t) => t * c)
          .map((t, r) => {
            let a = Math.min(t + c - 1, d - 1),
              o = { Range: `bytes=${t}-${a}` };
            return () =>
              fetch(url, { headers: o, signal: controller.signal }).then((res) => {
                if (408 === res.status) {
                  throw Error('fetch Error');
                }
              const mimeStr = res.headers.get('Content-Type');
              if (mimeStr && mimeStr.includes('text/html')) {
                 throw new Error("Received HTML instead of media.");
              }
              let prog = (((a + 1) / d) * 100).toFixed(2);
              if (prog > 100) prog = "100.00";
              reportProgress(id, prog);
              
              return res.arrayBuffer();
            });
        });
        

      
      let h = await getResult(progress, 20);
      let m = new Blob(h, { type: f || 'application/octet-stream' });
    
    let downloadUrl = URL.createObjectURL(m);
    reportProgress(id, "100.00");
    saveFromUrl(downloadUrl, name);
    cleanup();
    setTimeout(() => {
        window.URL.revokeObjectURL(downloadUrl);
    }, 60000);
  } catch (e) {
    if (e.name === 'AbortError' || e.message === 'AbortError') {
        if (typeof cleanup === 'function') cleanup();
        if (isPaused) {
            console.log('[Telegram Downloader] Segmented download paused');
            reportProgress(id, 'paused');
        } else {
            console.log('[Telegram Downloader] Segmented download aborted');
            reportProgress(id, 'aborted');
        }
        return;
    }
    console.log('[Telegram Downloader] Segmented fetch failed (likely CORS). Using background proxy fallback.');
    let rawName = providedTitle || getFileNameFromUrl(url, "video/mp4") || `download_${Date.now()}`;
    rawName = formatFileName(rawName, "video/mp4", "mp4");
    reportProgress(id, "100.00");
    document.dispatchEvent(new CustomEvent('media_fallback_download', {
        detail: { url: url, filename: rawName }
    }));
  }
}

async function getResult(e, t) {
  let r = [],
    a = 0;
  try {
    for (; a < e.length; ) {
      let o = e.slice(a, a + t).map((e) => e());
      let results = await Promise.all(o);
      r.push(...results);
      a += t;
    }
  } catch (err) {
      if (err.message !== "AbortError") throw err;
  }
  return r;
}

function saveFromUrl(url, name) {
  let r = document.createElement('a');
  r.href = url;
  r.download = name;
  document.body.appendChild(r);
  r.click();
  document.body.removeChild(r);
}

function getFileNameFromUrl(url, type) {
  let _file_extension = type.split('/')[1];
  try {
    let fileName, metadata = '';
    if (url.includes('progressive/')) {
      metadata = url.split('document').slice(1);
      fileName = metadata + '.' + _file_extension;
    } else {
      metadata = JSON.parse(JSON.parse(JSON.stringify(decodeURIComponent(url.split('/').slice(1).join('.')))));
      if (metadata.fileName) {
        fileName = metadata.fileName;
      } else if (metadata.location && metadata.location.id) {
        fileName = metadata.location.id + '.' + _file_extension;
      }
    }
    return fileName;
  } catch (e) {
    return null;
  }
}
