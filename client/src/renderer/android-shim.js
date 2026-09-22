// LiveBR — shim executado APENAS dentro do app Android (WebView).
// Fora do Android (Electron/desktop) este arquivo não faz nada:
// o preload do Electron já define window.livebr antes de qualquer script.
(function () {
  "use strict";

  // Sem a ponte nativa não somos o app Android — sai em silêncio.
  if (typeof window.AndroidBridge === "undefined") return;

  document.documentElement.classList.add("is-android");

  // Ponte "livebr" — equivalente ao preload do Electron, com o que
  // faz sentido no celular. O que é exclusivo do PC vira no-op/amigável.
  window.livebr = {
    platform: "android",
    /** O Android não deixa capturar a tela do sistema dentro da WebView. */
    getDisplaySources: function () {
      return Promise.resolve([]);
    },
    setDisplayOptions: function () {},
    /** Quem cria a sala é o PC; no celular o botão fica desabilitado. */
    createRoom: function () {
      return Promise.resolve({
        ok: false,
        error: "no Android quem cria a sala é o PC — abra o LiveBR no computador, clique em Criar sala e cole o código aqui (ou use a aba Sem servidor).",
      });
    },
    stopRoom: function () {
      return Promise.resolve({ ok: true });
    },
    onUpdateAvailable: function () {},
    onUpdateDownloaded: function () {},
    checkForUpdates: function () {
      return Promise.resolve(null);
    },
    installUpdate: function () {},
    /** Mixer/volume por app são recursos do Windows. */
    openVolumeMixer: function () {},
    listAudioApps: function () {
      return Promise.resolve([]);
    },
    setAppVolume: function () {},
    restoreAllAppVolumes: function () {},
  };

  // Clipboard nativo: navigator.clipboard nem sempre funciona na WebView.
  try {
    var clip = navigator.clipboard || {};
    clip.writeText = function (text) {
      try {
        window.AndroidBridge.copyText(String(text == null ? "" : text));
        return Promise.resolve();
      } catch (e) {
        return Promise.reject(e);
      }
    };
    try {
      Object.defineProperty(navigator, "clipboard", {
        value: clip,
        configurable: true,
        writable: true,
      });
    } catch (e2) {
      navigator.clipboard = clip;
    }
  } catch (e3) {
    /* clipboard indisponível — o renderer já tem fallback de toast */
  }

  // --- Ajustes de UI mobile (este script roda depois do DOM, antes do renderer) ---

  // Criar sala só existe no PC: desabilita e explica.
  var createBtn = document.getElementById("create-room-btn");
  if (createBtn) {
    createBtn.disabled = true;
    var hint = document.createElement("p");
    hint.className = "hint";
    hint.textContent =
      "No Android a sala é criada no PC: no computador clique em Criar sala e cole o código aqui. Entre dois celulares, use a aba Sem servidor.";
    createBtn.parentNode.insertBefore(hint, createBtn);
  }

  // Botão de participantes/chat — aparece só em telas estreitas (ver CSS).
  var topbar = document.querySelector(".topbar-right");
  if (topbar) {
    var toggle = document.createElement("button");
    toggle.className = "icon-btn mobile-only";
    toggle.title = "Participantes e chat";
    toggle.textContent = "👥";
    toggle.addEventListener("click", function () {
      document.documentElement.classList.toggle("sidebar-open");
    });
    topbar.insertBefore(toggle, topbar.firstChild);
  }

  // No celular quem compartilha é a câmera: o botão vira "Câmera" e o
  // modal abre já na aba dela (Telas/Janelas ficam ocultas no CSS).
  var shareBtn = document.getElementById("share-btn");
  if (shareBtn) {
    var lbl = shareBtn.querySelector(".lbl");
    var ico = shareBtn.querySelector(".ico");
    if (lbl) lbl.textContent = "Câmera";
    if (ico) ico.textContent = "📷";
    shareBtn.addEventListener("click", function () {
      // Depois que o renderer abrir o modal e carregar a lista de telas
      // (microtask), sintetiza o clique na aba Câmera.
      setTimeout(function () {
        var cam = document.querySelector('[data-src-type="camera"]');
        if (cam) cam.click();
      }, 0);
    });
  }

  // Mantém a tela ligada enquanto estiver na sala.
  try {
    var room = document.getElementById("room");
    window.AndroidBridge.keepScreenOn(false);
    if (room && typeof MutationObserver !== "undefined") {
      new MutationObserver(function () {
        window.AndroidBridge.keepScreenOn(!room.classList.contains("hidden"));
      }).observe(room, { attributes: true, attributeFilter: ["class"] });
    }
  } catch (e4) {
    /* keepScreenOn é opcional */
  }
})();
