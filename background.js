chrome.runtime.onInstalled.addListener(() => {
  console.log('Telegram Downloader Extension Installed');
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "download") {
        chrome.downloads.download({
            url: request.url,
            filename: request.filename,
            saveAs: false
        });
    }
});
