/// <reference types="chrome" />
export {};

const TOGGLE_INSPECT_MODE = "toggleInspectMode";

async function broadcastToggle(tabId: number): Promise<void> {
  let frames: chrome.webNavigation.GetAllFrameResultDetails[] = [];

  try {
    frames = (await chrome.webNavigation.getAllFrames({ tabId })) ?? [];
  } catch (error) {
    console.warn("Copy Frame: unable to enumerate frames", error);
  }

  if (!frames.length) {
    await chrome.tabs.sendMessage(tabId, { type: TOGGLE_INSPECT_MODE }).catch(() => undefined);
    return;
  }

  await Promise.all(
    frames.map((frame) =>
      chrome.tabs
        .sendMessage(
          tabId,
          { type: TOGGLE_INSPECT_MODE },
          frame.frameId === 0 ? {} : { frameId: frame.frameId }
        )
        .catch(() => undefined)
    )
  );
}

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) {
    return;
  }

  await broadcastToggle(tab.id);
});
