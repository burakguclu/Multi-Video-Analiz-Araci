document.addEventListener("DOMContentLoaded", () => {
  // --- Global Değişkenler ---
  let rootDirectoryHandle = null;
  let activePlayers = new Map(); // Key: player ID (int), Value: { handle: FileHandle, dirHandle: DirectoryHandle, isRoot: boolean }
  let videoInfoCache = new Map();
  let pendingVideoInfoRequests = new Map();
  let autoPausedByFullscreen = []; // YENİ: Tam ekran için

  const VIDEO_EXTENSIONS = [
    ".mp4",
    ".webm",
    ".ogg",
    ".mov",
    ".m4v",
    ".avi",
    ".wmv",
    ".mkv",
    ".flv",
    ".mpg",
    ".mpeg",
    ".3gp",
    ".vob",
    ".ts",
    ".m2ts",
    ".mts",
    ".divx",
  ];

  const FRAME_DURATION = 1 / 30;

  // HATA DÜZELTMESİ (1. İstek): 'normalize' kaldırıldı, sadece 'replace' kullanılıyor.
  const CONTROL_CHAR_REGEX = /[\u0000-\u001F\u007F-\u009F\u2000-\u206F\uFEFF]/g;

  function cleanName(name) {
    if (!name) return "";
    return name.replace(CONTROL_CHAR_REGEX, "").trim();
  }

  // --- HTML Elemanlarını Seçme ---
  const gridContainer = document.getElementById("video-grid-container");
  const layoutSelect = document.getElementById("layout-select");
  const playAllBtn = document.getElementById("play-all-btn");
  const pauseAllBtn = document.getElementById("pause-all-btn");
  const selectFolderBtn = document.getElementById("select-folder-btn");
  const loadingOverlay = document.getElementById("loading-overlay");
  const loadingText = document.getElementById("loading-text");

  // --- 1. Video Bilgisi İşleme (Thumbnail & Süre) ---

  function generateVideoInfo(fileHandle) {
    const cleanCacheKey = cleanName(fileHandle.name);

    if (pendingVideoInfoRequests.has(cleanCacheKey)) {
      return pendingVideoInfoRequests.get(cleanCacheKey);
    }

    const infoPromise = new Promise(async (resolve, reject) => {
      let video = document.createElement("video");
      let url = null;

      const cleanup = () => {
        if (url) {
          URL.revokeObjectURL(url);
          url = null;
        }
        if (video) {
          video.onerror = null;
          video.onloadedmetadata = null;
          video.onseeked = null;
          video.onstalled = null;
          video.remove();
          video = null;
        }
      };

      try {
        const file = await fileHandle.getFile();
        url = URL.createObjectURL(file);

        video.preload = "metadata";
        video.src = url;
        video.muted = true;
        video.playsInline = true;

        let duration = 0;

        video.onloadedmetadata = () => {
          duration = video.duration;
          if (isFinite(duration) && duration > 0) {
            video.currentTime = Math.min(1.0, duration / 2);
          } else {
            reject(new Error("Geçersiz video süresi (metadata)."));
          }
        };

        video.onseeked = () => {
          const canvas = document.createElement("canvas");
          const aspectRatio = video.videoWidth / video.videoHeight;
          canvas.width = 160;
          canvas.height = 160 / (aspectRatio || 16 / 9);
          if (isNaN(canvas.height) || canvas.height <= 0) {
            canvas.height = 90;
          }

          const ctx = canvas.getContext("2d");
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          const thumb = canvas.toDataURL("image/jpeg", 0.7);

          const result = { thumb, duration };
          videoInfoCache.set(cleanCacheKey, result);

          cleanup();
          canvas.remove();
          resolve(result);
        };

        video.onerror = (e) => {
          console.error("Video bilgi hatası:", e, fileHandle.name);
          cleanup();
          reject(new Error(`Video dosyası hatası: ${fileHandle.name}`));
        };

        video.onstalled = () => {
          cleanup();
          reject(new Error(`Video yüklenemedi (stalled): ${fileHandle.name}`));
        };
      } catch (err) {
        cleanup();
        reject(err);
      }
    });

    pendingVideoInfoRequests.set(cleanCacheKey, infoPromise);
    infoPromise.finally(() => {
      pendingVideoInfoRequests.delete(cleanCacheKey);
    });

    return infoPromise;
  }

  // --- 2. Klasör ve Dosya Gezintisi ---

  async function handleSelectFolderClick() {
    try {
      rootDirectoryHandle = await window.showDirectoryPicker();
      videoInfoCache.clear();
      pendingVideoInfoRequests.clear();
      activePlayers.clear();

      loadingOverlay.classList.remove("hidden");
      loadingText.textContent = "Tüm alt klasörler taranıyor...";

      const filesToProcess = await scanDirectoryRecursive(rootDirectoryHandle);

      if (filesToProcess.length > 0) {
        let processedCount = 0;
        loadingText.textContent = `0 / ${filesToProcess.length} video işleniyor...`;

        const processingPromises = filesToProcess.map((fileHandle) =>
          generateVideoInfo(fileHandle)
            .then(() => {
              processedCount++;
              loadingText.textContent = `${processedCount} / ${filesToProcess.length} video işlendi...`;
            })
            .catch((err) => {
              console.warn(`"${fileHandle.name}" için bilgi alınamadı:`, err);
              processedCount++;
              loadingText.textContent = `${processedCount} / ${filesToProcess.length} video işlendi...`;
            })
        );

        await Promise.all(processingPromises);
      }

      loadingOverlay.classList.add("hidden");
      updateLayout();
    } catch (err) {
      if (err.name !== "AbortError") console.error("Klasör seçilemedi:", err);
      loadingOverlay.classList.add("hidden");
    }
  }

  /**
   * HATA DÜZELTMESİ (1. İstek): startsWith('.') filtresi kaldırıldı.
   */
  async function scanDirectoryRecursive(dirHandle) {
    let videoFiles = [];
    try {
      for await (const entry of dirHandle.values()) {
        const cleanEntryName = cleanName(entry.name);

        // HATA DÜZELTMESİ (1. İstek): O satır tamamen kaldırıldı.

        if (entry.kind === "directory") {
          if (cleanEntryName.startsWith(".")) continue; // Gizli klasörleri atla
          const subFiles = await scanDirectoryRecursive(entry);
          videoFiles = videoFiles.concat(subFiles);
        } else if (entry.kind === "file") {
          if (cleanEntryName.startsWith(".")) continue; // Gizli dosyaları atla

          const parts = cleanEntryName.split(".");
          if (parts.length < 2) continue;
          const extension = "." + parts[parts.length - 1].toLowerCase();

          if (VIDEO_EXTENSIONS.includes(extension)) {
            videoFiles.push(entry);
          }
        }
      }
    } catch (err) {
      console.warn(
        `"${dirHandle.name}" klasörü okunamadı (izin sorunu olabilir):`,
        err
      );
    }
    return videoFiles;
  }

  // --- 3. UI Render ---

  async function renderFileListInSlot(emptyStateDiv, playerWrapper) {
    emptyStateDiv.innerHTML = "";

    const currentHandle = playerWrapper.currentDirHandle;
    const isRoot = playerWrapper.isRoot;

    if (!currentHandle) {
      emptyStateDiv.innerHTML = `<p class="empty-state-message">Videoları listelemek için lütfen yukarıdaki "Video Klasörü Seç" butonuna tıklayın.</p>`;
      return;
    }

    const localFileMap = new Map();
    const localSubfolderMap = new Map();

    try {
      for await (const entry of currentHandle.values()) {
        const cleanEntryName = cleanName(entry.name);

        // HATA DÜZELTMESİ (1. İstek): O satır tamamen kaldırıldı.

        if (entry.kind === "directory") {
          if (cleanEntryName.startsWith(".")) continue;
          localSubfolderMap.set(cleanEntryName, entry);
        } else if (entry.kind === "file") {
          if (cleanEntryName.startsWith(".")) continue;

          const parts = cleanEntryName.split(".");
          if (parts.length < 2) continue;
          const extension = "." + parts[parts.length - 1].toLowerCase();

          if (VIDEO_EXTENSIONS.includes(extension)) {
            localFileMap.set(cleanEntryName, entry);
          }
        }
      }
    } catch (err) {
      console.error(`"${currentHandle.name}" klasörü okunurken hata:`, err);
      emptyStateDiv.innerHTML = `<p class="empty-state-message">Bu klasör okunamadı. Lütfen izinleri kontrol edin.</p>`;
      return;
    }

    if (localFileMap.size === 0 && localSubfolderMap.size === 0) {
      emptyStateDiv.innerHTML = `<p class="empty-state-message">Bu klasörde video veya alt klasör bulunamadı.</p>`;
    }

    const searchBar = document.createElement("input");
    searchBar.type = "search";
    searchBar.placeholder = "Videolarda Ara...";
    searchBar.className = "search-bar";

    const list = document.createElement("ul");
    list.className = "empty-state-list";

    emptyStateDiv.appendChild(searchBar);
    emptyStateDiv.appendChild(list);

    if (!isRoot) {
      const li = document.createElement("li");
      li.className = "back-button";
      li.innerHTML = `<span>.. ↩ (Geri)</span>`;
      li.addEventListener("click", async () => {
        try {
          const path = await rootDirectoryHandle.resolve(currentHandle);
          if (!path || path.length === 0) {
            playerWrapper.currentDirHandle = rootDirectoryHandle;
            playerWrapper.isRoot = true;
          } else {
            let parentHandle = rootDirectoryHandle;
            const parentPath = path.slice(0, -1);
            for (const segment of parentPath) {
              parentHandle = await parentHandle.getDirectoryHandle(segment);
            }
            playerWrapper.currentDirHandle = parentHandle;
            playerWrapper.isRoot = await parentHandle.isSameEntry(
              rootDirectoryHandle
            );
          }
          await renderFileListInSlot(emptyStateDiv, playerWrapper);
        } catch (err) {
          console.error("Geri gidilemedi, köke dönülüyor:", err);
          playerWrapper.currentDirHandle = rootDirectoryHandle;
          playerWrapper.isRoot = true;
          await renderFileListInSlot(emptyStateDiv, playerWrapper);
        }
      });
      list.appendChild(li);
    }

    const sortedFolderNames = Array.from(localSubfolderMap.keys()).sort(
      (a, b) =>
        a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" })
    );
    for (const folderName of sortedFolderNames) {
      const li = document.createElement("li");
      li.className = "folder-item";
      li.title = folderName;
      li.innerHTML = `<span>📁 ${folderName}</span>`;
      li.addEventListener("click", async () => {
        playerWrapper.currentDirHandle = localSubfolderMap.get(folderName);
        playerWrapper.isRoot = false;
        await renderFileListInSlot(emptyStateDiv, playerWrapper);
      });
      list.appendChild(li);
    }

    const sortedVideoNames = Array.from(localFileMap.keys()).sort((a, b) =>
      a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" })
    );

    for (const cleanFileName of sortedVideoNames) {
      const li = document.createElement("li");
      li.title = cleanFileName;

      const videoInfo = videoInfoCache.get(cleanFileName);

      const thumbContainer = document.createElement("div");
      thumbContainer.className = "thumbnail-container";

      const img = document.createElement("img");
      if (videoInfo && videoInfo.thumb) {
        img.src = videoInfo.thumb;
        img.alt = "thumbnail";
      } else {
        img.alt = "Hata";
        img.style.backgroundColor = "#522";
      }

      const durationSpan = document.createElement("span");
      durationSpan.className = "video-duration";
      durationSpan.textContent =
        videoInfo && videoInfo.duration
          ? formatTime(videoInfo.duration)
          : "??:??";

      thumbContainer.appendChild(img);
      thumbContainer.appendChild(durationSpan);

      const nameSpan = document.createElement("span");
      nameSpan.className = "file-name";
      nameSpan.textContent = cleanFileName;

      li.appendChild(thumbContainer);
      li.appendChild(nameSpan);

      li.addEventListener("click", () => {
        const fileHandle = localFileMap.get(cleanFileName);
        loadVideoFromFile(fileHandle, playerWrapper);
      });
      list.appendChild(li);
    }

    searchBar.addEventListener("input", (e) => {
      const searchTerm = cleanName(e.target.value).toLowerCase();
      list.querySelectorAll("li").forEach((li) => {
        const text = li.textContent.toLowerCase();
        if (text.includes(searchTerm)) {
          li.style.display = "flex";
        } else {
          li.style.display = "none";
        }
      });
    });
  }

  // --- 4. Video Load (HATA DÜZELTMESİ 2 - blob) ---

  async function loadVideoFromFile(fileHandle, playerWrapper) {
    let file;
    try {
      file = await fileHandle.getFile();
    } catch (err) {
      console.error("Dosya alınamadı (belki izinler değişti?):", err);
      alert("Dosya yüklenemedi. Lütfen klasörü yeniden seçin.");
      return;
    }

    const video = playerWrapper.querySelector("video");
    if (video.src) URL.revokeObjectURL(video.src);

    video.src = URL.createObjectURL(file);
    video.load();
    video.play();
    playerWrapper.classList.add("video-loaded");

    // YENİ: Başlık çubuğunu ayarla
    const titleBar = playerWrapper.querySelector(".video-title-bar");
    const cleanFileName = cleanName(fileHandle.name);
    titleBar.textContent = cleanFileName;
    titleBar.title = cleanFileName; // Tam adı görmek için

    // HATA DÜZELTMESİ (2. İstek): Aktif oynatıcıya 'FileHandle'ı VE 'DirectoryHandle'ı kaydet
    const playerId = parseInt(playerWrapper.dataset.playerId);
    activePlayers.set(playerId, {
      handle: fileHandle,
      dirHandle: playerWrapper.currentDirHandle,
      isRoot: playerWrapper.isRoot,
    });
  }

  // --- 5. Controls ---

  function formatTime(seconds) {
    if (isNaN(seconds) || seconds === 0) return "00:00";
    const min = Math.floor(seconds / 60);
    const sec = Math.floor(seconds % 60);
    return `${min.toString().padStart(2, "0")}:${sec
      .toString()
      .padStart(2, "0")}`;
  }

  async function updateLayout() {
    const newCount = parseInt(layoutSelect.value);

    const snapshot = new Map(activePlayers);
    activePlayers.clear();

    gridContainer.innerHTML = "";
    gridContainer.className = `layout-${newCount}`;

    const dataToRestore = Array.from(snapshot.keys())
      .sort((a, b) => a - b)
      .map((key) => snapshot.get(key));

    const allWrappers = [];
    for (let i = 0; i < newCount; i++) {
      const playerWrapper = createPlayerInstance(i);
      allWrappers.push(playerWrapper);
    }

    // Await (bekleme) işlemlerini döngü dışına alarak performansı artır
    const renderTasks = [];
    for (let i = 0; i < newCount; i++) {
      const playerWrapper = allWrappers[i];

      if (dataToRestore[i]) {
        const info = dataToRestore[i];
        playerWrapper.currentDirHandle = info.dirHandle;
        playerWrapper.isRoot = info.isRoot;
        // Yüklemeyi bir 'task' (görev) olarak ekle
        renderTasks.push(loadVideoFromFile(info.handle, playerWrapper));
      } else {
        playerWrapper.currentDirHandle = rootDirectoryHandle;
        playerWrapper.isRoot = rootDirectoryHandle !== null;
        renderTasks.push(
          renderFileListInSlot(
            playerWrapper.querySelector(".empty-state"),
            playerWrapper
          )
        );
      }
    }
    await Promise.all(renderTasks); // Tüm yuvaların dolmasını bekle
  }

  function createPlayerInstance(id) {
    const playerWrapper = document.createElement("div");
    playerWrapper.className = "player-wrapper";
    playerWrapper.dataset.playerId = id;

    playerWrapper.currentDirHandle = null;
    playerWrapper.isRoot = true;

    // YENİ: Başlık çubuğu eklendi
    playerWrapper.innerHTML = `
      <div class="empty-state"></div>
      <div class="video-title-bar"></div> <video preload="auto"></video>
      <div class="video-controls">
          <div class="timeline-container">
              <span class="time-display">00:00 / 00:00</span>
              <input type="range" class="timeline-slider" min="0" max="100" step="0.1" value="0">
          </div>
          <button class="play-pause-btn" title="Oynat/Durdur">⏸️</button>
          <button class="frame-back-btn" title="Kare Geri">«</button>
          <button class="frame-fwd-btn" title="Kare İleri">»</button>
          <div class="speed-control">
              <input type="range" class="speed-slider" min="0.25" max="4" step="0.25" value="1" title="Oynatma Hızı">
              <span class="speed-display">1.0x</span>
          </div>
          <div class="volume-container">
              <button class="mute-btn" title="Sessize Al/Aç">🔊</button>
              <input type="range" class="volume-slider" min="0" max="1" step="0.01" value="1">
          </div>
          <button class="fullscreen-btn" title="Tam Ekran">⛶</button>
          <button class="close-btn" title="Videoyu Kapat">❌</button>
      </div>
    `;

    gridContainer.appendChild(playerWrapper);

    const emptyStateDiv = playerWrapper.querySelector(".empty-state");
    const video = playerWrapper.querySelector("video");
    const closeBtn = playerWrapper.querySelector(".close-btn");
    const playPauseBtn = playerWrapper.querySelector(".play-pause-btn");
    const frameBackBtn = playerWrapper.querySelector(".frame-back-btn");
    const frameFwdBtn = playerWrapper.querySelector(".frame-fwd-btn");
    const timelineSlider = playerWrapper.querySelector(".timeline-slider");
    const timeDisplay = playerWrapper.querySelector(".time-display");
    const speedSlider = playerWrapper.querySelector(".speed-slider");
    const speedDisplay = playerWrapper.querySelector(".speed-display");
    const muteBtn = playerWrapper.querySelector(".mute-btn");
    const volumeSlider = playerWrapper.querySelector(".volume-slider");
    const fullscreenBtn = playerWrapper.querySelector(".fullscreen-btn");
    const titleBar = playerWrapper.querySelector(".video-title-bar"); // YENİ

    // --- Olay Dinleyicileri ---

    // Kapatma
    closeBtn.addEventListener("click", () => {
      video.pause();
      if (video.src) URL.revokeObjectURL(video.src);
      video.removeAttribute("src");
      playerWrapper.classList.remove("video-loaded");
      activePlayers.delete(id);

      titleBar.textContent = ""; // YENİ: Başlığı temizle

      renderFileListInSlot(emptyStateDiv, playerWrapper);

      playPauseBtn.textContent = "▶️";
      timeDisplay.textContent = "00:00 / 00:00";
      timelineSlider.value = 0;
    });

    // Kontroller
    playPauseBtn.addEventListener("click", () => togglePlayPause(video));

    // YENİ: Çift tıklama ile tam ekran
    video.addEventListener("dblclick", () => toggleFullscreen(playerWrapper));

    // YENİ: Buton ile tam ekran
    fullscreenBtn.addEventListener("click", () =>
      toggleFullscreen(playerWrapper)
    );

    // YENİ: Tek tıklama (videoya)
    video.addEventListener("click", (e) => {
      // Çift tıklamayı tetiklememek için kısa bir gecikme
      setTimeout(() => {
        if (e.detail === 1) {
          // Sadece tek tıklama ise
          togglePlayPause(video);
        }
      }, 200);
    });

    frameFwdBtn.addEventListener("click", () => stepFrame(video, 1));
    frameBackBtn.addEventListener("click", () => stepFrame(video, -1));

    video.addEventListener("play", () => (playPauseBtn.textContent = "⏸️"));
    video.addEventListener("pause", () => (playPauseBtn.textContent = "▶️"));

    video.addEventListener("loadedmetadata", () => {
      if (isFinite(video.duration)) {
        timelineSlider.max = video.duration;
        timeDisplay.textContent = `${formatTime(0)} / ${formatTime(
          video.duration
        )}`;
      }
    });

    video.addEventListener("timeupdate", () => {
      if (isFinite(video.duration)) {
        timelineSlider.value = video.currentTime;
        timeDisplay.textContent = `${formatTime(
          video.currentTime
        )} / ${formatTime(video.duration)}`;
      }
    });

    // HATA DÜZELTMESİ (Yazım hatası): 'targe.value' -> 'target.value'
    timelineSlider.addEventListener("input", (e) => {
      if (isFinite(video.duration)) {
        video.currentTime = parseFloat(e.target.value);
      }
    });

    speedSlider.addEventListener("input", (e) => {
      video.playbackRate = parseFloat(e.target.value);
      speedDisplay.textContent = `${video.playbackRate.toFixed(2)}x`;
    });

    volumeSlider.addEventListener("input", (e) => {
      video.volume = parseFloat(e.target.value);
      video.muted = video.volume === 0;
    });

    muteBtn.addEventListener("click", () => {
      video.muted = !video.muted;
    });

    video.addEventListener("volumechange", () => {
      volumeSlider.value = video.muted ? 0 : video.volume;
      if (video.muted || video.volume === 0) {
        muteBtn.textContent = "🔇";
      } else if (video.volume < 0.5) {
        muteBtn.textContent = "🔉";
      } else {
        muteBtn.textContent = "🔊";
      }
    });

    return playerWrapper;
  }

  // --- Yardımcı Fonksiyonlar ---
  function togglePlayPause(video) {
    if (!video.src) return;
    if (video.paused || video.ended) {
      video.play();
    } else {
      video.pause();
    }
  }

  function stepFrame(video, direction) {
    if (!video.src) return;
    video.pause();
    video.currentTime += FRAME_DURATION * direction;
  }

  function playAll() {
    document.querySelectorAll("#video-grid-container video").forEach((v) => {
      if (v.src && v.paused) v.play();
    });
  }

  function pauseAll() {
    document
      .querySelectorAll("#video-grid-container video")
      .forEach((v) => v.pause());
  }

  // --- YENİ: Tam Ekran Fonksiyonları ---

  function toggleFullscreen(playerWrapper) {
    if (!document.fullscreenElement) {
      enterFullscreen(playerWrapper);
    } else {
      exitFullscreen();
    }
  }

  function enterFullscreen(playerWrapper) {
    const targetVideo = playerWrapper.querySelector("video");
    if (!targetVideo || !targetVideo.src) return; // Video yüklü değilse yapma

    document
      .querySelectorAll("#video-grid-container video")
      .forEach((video) => {
        if (video !== targetVideo && !video.paused) {
          video.pause();
          autoPausedByFullscreen.push(video);
        }
      });

    playerWrapper.requestFullscreen();
  }

  function exitFullscreen() {
    if (document.fullscreenElement) {
      document.exitFullscreen();
    }
  }

  function handleFullscreenChange() {
    if (!document.fullscreenElement) {
      autoPausedByFullscreen.forEach((video) => {
        if (video) video.play();
      });
      autoPausedByFullscreen = [];
    }
  }

  // --- Başlangıç Olay Dinleyicileri ---
  playAllBtn.addEventListener("click", playAll);
  pauseAllBtn.addEventListener("click", pauseAll);
  layoutSelect.addEventListener("change", updateLayout);
  selectFolderBtn.addEventListener("click", handleSelectFolderClick);
  document.addEventListener("fullscreenchange", handleFullscreenChange);

  updateLayout();
});
