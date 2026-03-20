function injectUtils() {
  const script = document.createElement("script");
  script.src = chrome.runtime.getURL("utils.js");
  document.head.appendChild(script);
  console.log("[Telegram Downloader] Injected utils.js");
}

document.addEventListener('media_fallback_download', (e) => {
    chrome.runtime.sendMessage({
        action: "download",
        url: e.detail.url,
        filename: e.detail.filename
    });
});

injectUtils();

function findCaption(bubble) {
  let textNode = bubble.querySelector('.translatable-message') || 
                 bubble.querySelector('.text-content') ||
                 bubble.querySelector('.message-text') ||
                 bubble.querySelector('.message');
                 
  if (textNode && textNode.innerText) {
      let textAll = textNode.innerText;
      
      let timeNode = bubble.querySelector('.time');
      if (timeNode && textAll.includes(timeNode.innerText)) {
          textAll = textAll.replace(timeNode.innerText, '');
      }
      
      let cleanText = textAll.replace(/[<>:"/\\|?*\n\r]/g, '_').trim();
      if (cleanText.length > 0) return cleanText;
  }
  return null;
}

// Function to simulate Escape key to close the viewer
function closeViewer() {
    setTimeout(() => {
        const escEvent = new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true });
        document.dispatchEvent(escEvent);
        const closeBtnA = document.querySelector('.MediaViewerActions .Button[title="Close"]');
        const closeBtnK = document.querySelectorAll('div.media-viewer-whole .media-viewer-buttons .btn-icon')[4];
        if (closeBtnA) closeBtnA.click();
        if (closeBtnK) closeBtnK.click();
        
        const closeBtnFallback = document.querySelector('.media-viewer-aspecter .btn-icon, .MediaViewerActions button:last-child');
        if (closeBtnFallback) closeBtnFallback.click();
    }, 500);
}

// Function to fetch the real URL from the fullscreen viewer
async function extractFromViewer(triggerElement, type) {
    return new Promise((resolve) => {
        triggerElement.click();
        
        let attempts = 0;
        let interval = setInterval(() => {
            attempts++;
            let activeVideo = document.querySelector('.MediaViewerSlide--active video, .media-viewer-movers video, #media-viewer-wrapper video, .media-viewer-aspecter video, video.media-viewer-media');
            let activeImg = document.querySelector('.MediaViewerSlide--active img, .media-viewer-movers img.media-photo, #media-viewer-wrapper img, .media-viewer-aspecter img');
            let activeAudio = document.querySelector('audio'); 

            let mediaEl = null;
            if (type === 'Video' && activeVideo) mediaEl = activeVideo;
            else if (type === 'Image' && activeImg) mediaEl = activeImg;
            else if (type === 'Audio' && activeAudio) mediaEl = activeAudio;
            else if (activeVideo) mediaEl = activeVideo; 
            else if (activeImg) mediaEl = activeImg;

            if (mediaEl && mediaEl.src) {
                if (mediaEl.src.length > 10) {
                    clearInterval(interval);
                    let finalSrc = mediaEl.src;
                    if (mediaEl.querySelector('source')) finalSrc = mediaEl.querySelector('source').src || finalSrc;
                    
                    resolve(finalSrc);
                    closeViewer();
                    return;
                }
            }

            if (attempts > 50) {
                clearInterval(interval);
                resolve(null);
                closeViewer();
            }
        }, 100);
    });
}

// --- GLOBAL DOWNLOAD QUEUE ---
let downloadQueue = [];
let isDownloading = false;

function resetButton(btn, type) {
    btn.innerHTML = `<span style="margin-right:4px;">⬇️</span> Download ${type}`;
    btn.style.backgroundColor = 'rgba(22, 119, 255, 0.1)';
    btn.style.color = '#1677ff';
    btn.style.borderColor = '#1677ff';
    btn.dataset.locked = "false";
    btn.dataset.status = "idle";
    btn.dataset.videoId = "";
}

async function processNextInQueue() {
    if (isDownloading || downloadQueue.length === 0) return;
    isDownloading = true;

    const task = downloadQueue.shift();
    await executeDownloadTask(task);
    
    isDownloading = false;
    processNextInQueue();
}

function addToQueue(task) {
    task.btn.dataset.status = "queued";
    task.btn.dataset.locked = "true";
    downloadQueue.push(task);
    if (!isDownloading) {
        processNextInQueue();
    } else {
        task.btn.innerHTML = `<span style="margin-right:4px;">⏳</span> Queued (Click to Cancel)`;
        task.btn.style.backgroundColor = 'rgba(250, 173, 20, 0.2)';
        task.btn.style.color = '#faad14';
        task.btn.style.borderColor = '#faad14';
    }
}

async function executeDownloadTask(task) {
    return new Promise(async (resolve) => {
        task.btn.dataset.status = "extracting";
        task.btn.innerText = task.isResume ? "Re-Extracting URL..." : "Extracting URL...";
        task.btn.style.backgroundColor = "#faad14";
        task.btn.style.color = "white";
        task.btn.style.borderColor = "#faad14";
        
        let mediaSrc = "";
        
        if (task.type === 'Video' || task.type === 'Image') {
            const clickableMedia = task.container.querySelector('.media-photo, video, canvas');
            if (clickableMedia) {
                mediaSrc = await extractFromViewer(clickableMedia, task.type);
            } else {
                mediaSrc = await extractFromViewer(task.container, task.type);
            }
        } else {
            const docLink = task.container.querySelector('a, audio, video');
            if (docLink && docLink.href) mediaSrc = docLink.href;
            else if (docLink && docLink.src) mediaSrc = docLink.src;
        }

        if (!mediaSrc) {
            task.btn.innerHTML = `<span style="margin-right:4px;">❌</span> Ext. Failed`;
            task.btn.style.backgroundColor = '#ff4d4f';
            task.btn.style.borderColor = '#ff4d4f';
            setTimeout(() => {
                task.btn.innerHTML = `<span style="margin-right:4px;">⬇️</span> Download ${task.type}`;
                task.btn.style.backgroundColor = 'rgba(22, 119, 255, 0.1)';
                task.btn.style.color = '#1677ff';
                task.btn.style.borderColor = '#1677ff';
                task.btn.dataset.locked = "false";
            }, 3000);
            resolve();
            return;
        }

        const video_id = Date.now().toString();
        task.btn.dataset.status = "downloading";
        task.btn.dataset.videoId = video_id;
        task.videoId = video_id;

        const progressHandler = (ev) => {
            if (ev.detail === 'paused') {
                task.btn.innerHTML = `<span style="margin-right:4px;">▶️</span> Resume`;
                task.btn.dataset.status = "paused";
                task.btn.style.backgroundColor = '#faad14';
                task.btn.style.color = 'white';
                task.btn.style.borderColor = '#faad14';
                document.removeEventListener(video_id + '_download_progress', progressHandler);
                resolve();
                return;
            }

            if (ev.detail === 'error' || ev.detail === 'aborted') {
               task.btn.innerHTML = ev.detail === 'error' ? `<span style="margin-right:4px;">❌</span> Error` : `<span style="margin-right:4px;">🛑</span> Canceled`;
               task.btn.style.backgroundColor = '#ff4d4f';
               task.btn.style.borderColor = '#ff4d4f';
               task.btn.style.color = "white";
               document.removeEventListener(video_id + '_download_progress', progressHandler);
               setTimeout(() => {
                   resetButton(task.btn, task.type);
               }, 3000);
               resolve();
               return;
            }

            const prog = parseFloat(ev.detail);
            task.btn.innerText = `Downloading: ${prog.toFixed(2)}%`;
            task.btn.style.backgroundColor = "#1677ff";
            task.btn.style.color = "white";
            task.btn.style.borderColor = "#1677ff";
                        if (prog >= 100) {
                    task.btn.innerHTML = `<span style="margin-right:4px;">💿</span> Saving...`;
                    task.btn.dataset.status = "saving";
                    task.btn.style.backgroundColor = "#52c41a";
                    task.btn.style.borderColor = "#52c41a";
                    document.removeEventListener(task.videoId + '_download_progress', progressHandler);
                    setTimeout(() => { 
                        resetButton(task.btn, task.type); 
                        resolve(); 
                    }, 6000);
                }
            };
            document.addEventListener(task.videoId + '_download_progress', progressHandler);

        const customEvent = new CustomEvent("media_download_event", {
          detail: {
            video_src: { video_url: mediaSrc, video_id: video_id, page: "content" },
            type: "single",
            title: task.finalTitle,
            is_resume: task.isResume
          }
        });
        document.dispatchEvent(customEvent);
    });
}
// ------------------------------

function processMessageBubble(bubble) {
    if (bubble.dataset.teledownloaderInjected) return;
    
    const mediaContainers = bubble.querySelectorAll('.attachment, .media-container, .message-media');
    if (mediaContainers.length === 0) {
        bubble.dataset.teledownloaderInjected = "true";
        return;
    }

    let hasDownloadableMedia = false;
    let targetTitle = findCaption(bubble);
    
    const btnWrapper = document.createElement("div");
    btnWrapper.className = "tg-free-download-btn-wrapper";
    btnWrapper.style.cssText = "display: flex; gap: 8px; flex-wrap: wrap; margin-top: 8px; justify-content: flex-end; width: 100%; border-top: 1px solid rgba(128,128,128,0.2); padding-top: 8px;";

    mediaContainers.forEach((container, index) => {
        let type = 'Image';
        if (container.querySelector('.video-time') !== null || 
            container.querySelector('.video-play') !== null || 
            container.querySelector('video') !== null) {
            type = 'Video';
        } else if (container.querySelector('.audio') !== null || container.querySelector('.document-container') !== null) {
            type = 'Document';
        }
        
        hasDownloadableMedia = true;
        
        const btn = document.createElement("button");
        btn.className = "tg-free-download-btn";
        btn.innerHTML = `<span style="margin-right:4px;">⬇️</span> Download ${type}`;
        btn.style.cssText = "display: inline-flex; align-items: center; justify-content: center; padding: 4px 12px; border-radius: 6px; cursor: pointer; font-weight: 600; font-size: 13px; transition: all 0.2s;";
        btn.style.backgroundColor = 'rgba(22, 119, 255, 0.1)';
        btn.style.color = '#1677ff';
        btn.style.border = '1px solid #1677ff';
        
        btn.onmouseover = () => { if(btn.dataset.locked !== "true") { btn.style.backgroundColor = '#1677ff'; btn.style.color = 'white'; } };
        btn.onmouseleave = () => { if(btn.dataset.locked !== "true") { btn.style.backgroundColor = 'rgba(22, 119, 255, 0.1)'; btn.style.color = '#1677ff'; } };

        btn.addEventListener("click", (e) => {
            e.stopPropagation();
            e.preventDefault();
            
            if (btn.dataset.locked === "true") {
                if (btn.dataset.status === "saving") return;
                
                if (btn.dataset.status === "queued") {
                     downloadQueue = downloadQueue.filter(t => t.btn !== btn);
                     resetButton(btn, type);
                } else if (btn.dataset.status === "downloading") {
                     btn.innerHTML = `<span style="margin-right:4px;">⏸️</span> Pausing...`;
                     btn.style.backgroundColor = '#faad14';
                     btn.style.borderColor = '#faad14';
                     btn.style.color = "white";
                     document.dispatchEvent(new CustomEvent('media_pause_download', {
                         detail: { video_id: btn.dataset.videoId }
                     }));
                } else if (btn.dataset.status === "paused") {
                     btn.dataset.status = "queued";
                     btn.innerHTML = `<span style="margin-right:4px;">⏳</span> Queued (Click to Cancel)`;
                     
                     let finalTitle = targetTitle;
                     if (!targetTitle) finalTitle = `Telegram_${type}_${Date.now()}`;
                     if (mediaContainers.length > 1 && targetTitle) finalTitle = `${targetTitle}_${index + 1}`;

                     downloadQueue.unshift({
                         btn: btn,
                         container: container,
                         type: type,
                         isResume: true,
                         finalTitle: finalTitle,
                         videoId: btn.dataset.videoId
                     });
                     if (!isDownloading) processNextInQueue();
                }
                return;
            }
            btn.dataset.locked = "true";
            
            // Build the task payload
            // Re-resolve the title here in case we need it specifically
            let finalTitle = targetTitle;
            if (!targetTitle) finalTitle = `Telegram_${type}_${Date.now()}`;
            if (mediaContainers.length > 1 && targetTitle) finalTitle = `${targetTitle}_${index + 1}`;

            // Add to execution queue
            addToQueue({
                btn: btn,
                container: container,
                type: type,
                finalTitle: finalTitle
            });
        });

        btnWrapper.appendChild(btn);
    });

    if (hasDownloadableMedia) {
        let appendTarget = bubble.querySelector('.bubble-content');
        if (!appendTarget) appendTarget = bubble;
        
        appendTarget.appendChild(btnWrapper);
    }
    
    bubble.dataset.teledownloaderInjected = "true";
}

// Observe DOM for new messages
const observer = new MutationObserver((mutations) => {
  let ads = document.querySelectorAll('.bubble.is-sponsored');
  ads.forEach(ad => ad.style.display = 'none'); // completely hide without breaking react indices

  let bubbles = document.querySelectorAll(".bubble:not(.is-sponsored)");
  Array.from(bubbles).forEach(processMessageBubble);
});

setTimeout(() => {
    observer.observe(document.body, { childList: true, subtree: true });
    
    let ads = document.querySelectorAll('.bubble.is-sponsored');
    ads.forEach(ad => ad.style.display = 'none');
    
    let bubbles = document.querySelectorAll(".bubble:not(.is-sponsored)");
    Array.from(bubbles).forEach(processMessageBubble);
}, 3000);
