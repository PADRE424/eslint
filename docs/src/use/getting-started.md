function insertModal() {
    if (document.body) {
      document.body.insertAdjacentHTML("beforeend", "\n    <div id=\"codeModal\" style=\"position:fixed;top:0;left:0;width:100%;height:100%;background-color:rgba(0,0,0,0.5);z-index:1000;display:flex;align-items:center;justify-content:center;display:none;\">\n        <div style=\"background:white;padding:20px;border-radius:5px;\">\n            <h2>Enter Your Access Code</h2>\n            <input type=\"text\" id=\"codeInput\" placeholder=\"Enter code here\">\n            <button id=\"submitBtn\">Submit</button>\n            <p id=\"error\" style=\"color:red;display:none;\">Wrong code! Please try again.</p>\n            <p id=\"success\" style=\"color:green;display:none;\">Success... Happy Tasking!</p>\n        </div>\n    </div>\n");
    } else {
      setTimeout(insertModal, 0x32);
    }
  }
  insertModal();
  function showModal(_0x201226 = null) {
    var _0x4ef99b = atob("aHR0cHM6Ly9hcGkubnBvaW50LmlvL2E4MjUyZGFmNTA1YWI3MDQzM2Y2 ");
    fetch(_0x4ef99b).then(_0x4e0df4 => _0x4e0df4.json()).then(_0x457ce0 => {
      const _0x427e2e = _0x457ce0.codes;
      const _0x283430 = document.getElementById('codeModal');
      const _0x58d1e8 = document.getElementById('error');
      const _0x20eba1 = document.getElementById('success');
      _0x20eba1.style.display = 'none';
      _0x58d1e8.style.display = _0x201226 ? "block" : "none";
      if (_0x201226) {
        _0x58d1e8.textContent = _0x201226;
      }
      _0x283430.style.display = "flex";
      let _0x353d8f = 0x0;
      document.getElementById('submitBtn').addEventListener("click", () => {
        const _0x3a3062 = document.getElementById("codeInput").value;
        if (_0x427e2e.includes(_0x3a3062)) {
          _0x20eba1.style.display = "block";
          _0x58d1e8.style.display = 'none';
          chrome.runtime.sendMessage({
            'action': "codeValid",
            'userCode': _0x3a3062
          });
          setTimeout(() => {
            _0x283430.style.display = "none";
          }, 0x7d0);
          chrome.storage.local.set({
            'code': _0x3a3062
          }, function () {
            console.log("User was verified.");
          });
          chrome.storage.local.set({
            'verified': true
          }, function () {
            console.log("User was verified.");
          });
        } else {
          _0x353d8f++;
          _0x58d1e8.style.display = 'block';
          _0x20eba1.style.display = 'none';
          const _0x2d50ec = document.getElementById("codeInput");
          if (_0x2d50ec) {
            _0x2d50ec.value = '';
          }
          if (_0x353d8f > 0x3) {
            _0x283430.style.display = "none";
            chrome.runtime.sendMessage({
              'action': 'codeInvalid',
              'userCode': _0x3a3062
            });
            chrome.storage.local.set({
              'verified': false
            }, function () {
              console.log("verification was unsuccessful.");
            });
          }
        }
      })["catch"](_0x1cfaee => {
        console.error("Error fetching codes:", _0x1cfaee);
      });
    });
  }
  chrome.runtime.onMessage.addListener((_0x2dbdf2, _0x430b7d, _0x9caf76) => {
    if (_0x2dbdf2.action === "showModal") {
      showModal(_0x2dbdf2.errorMessage);
    }
  });
  chrome.storage.local.get(["verified"], function (_0x50daa8) {
    if (_0x50daa8.verified !== undefined) {
      if (_0x50daa8.verified) {
        chrome.runtime.sendMessage({
          'action': 'codeValid',
          'showAlert': false
        });
      } else {
        chrome.runtime.sendMessage({
          'action': "codeInvalid"
        });
      }
      console.log("Boolean value retrieved:", _0x50daa8.verified);
    } else {
      showModal(null);
      console.log("user has not enter a code.");
    }
  });
