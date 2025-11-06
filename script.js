
async function signInAndScan() {
  const provider = new firebase.auth.GoogleAuthProvider();
  provider.addScope("https://www.googleapis.com/auth/gmail.readonly");

  try {
    const result = await firebase.auth().signInWithPopup(provider);
    const credential = result.credential;
    if (!credential) {
      console.error("No credential returned from sign-in.");
      alert("Sign-in succeeded but no credential was returned. Try again.");
      return;
    }

    const accessToken = credential.accessToken;
    console.log("✅ Got access token (dev only) — length:", accessToken?.length || 0);
    alert("Signed in successfully. You can now scan Gmail.");

    const ids = await listMessageIds(accessToken);
    console.log("📩 Retrieved message IDs:", ids);

    
    if (ids && ids.length) {
      await fetchAndShowServices(accessToken, ids);
    } else {
      renderServices([]);
    }
  } catch (err) {
    console.error("Sign-in failed:", err);
    if (err.code === "auth/popup-blocked") {
      alert("Popup blocked. Allow popups for this site and try again.");
    } else if (err.code === "auth/popup-closed-by-user") {
      alert("Sign-in popup was closed before completing. Try again.");
    } else {
      alert("Sign-in error: " + (err.message || err));
    }
  }
}

const loginButton = document.getElementById("login");
if (loginButton) loginButton.addEventListener("click", signInAndScan);


async function listMessageIds(accessToken) {
  const query =
    'subject:(welcome OR verify OR "confirm your" OR "activate" OR "account") newer_than:365d';
  const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(
    query
  )}&maxResults=10`;

  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!res.ok) {
      throw new Error(`Gmail API error: ${res.status}`);
    }

    const data = await res.json();
    if (!data.messages || data.messages.length === 0) {
      alert("No matching emails found. Try again later!");
      return [];
    }

    console.log(`✅ Found ${data.messages.length} messages`);
    return data.messages; // [{id, threadId}, ...]
  } catch (err) {
    console.error("Error fetching Gmail messages:", err);
    alert("Failed to fetch Gmail messages. Check console for details.");
    return [];
  }
}



function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getMessageMetadata(accessToken, messageId) {
  const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`metadata fetch ${res.status}: ${txt}`);
  }

  return res.json();
}


async function withRetries(fn, attempts = 4, initialDelay = 300) {
  let last;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      await sleep(initialDelay * Math.pow(2, i));
    }
  }
  throw last;
}

async function fetchSubjectsInBatches(accessToken, messages, batchSize = 8, pauseMs = 250) {
  const results = [];
  for (let i = 0; i < messages.length; i += batchSize) {
    const batch = messages.slice(i, i + batchSize);
    const promises = batch.map((m) =>
      withRetries(() => getMessageMetadata(accessToken, m.id))
        .then((json) => ({ ok: true, json, id: m.id }))
        .catch((err) => ({ ok: false, err, id: m.id }))
    );
    const batchResults = await Promise.all(promises);
    results.push(...batchResults);
    await sleep(pauseMs);
  }
  return results;
}

function extractSubject(headers = []) {
  const h = headers.find((x) => x.name && x.name.toLowerCase() === "subject");
  return h ? h.value : "";
}

function detectServiceFromSubject(subject) {
  if (!subject) return null;
  const s = subject.replace(/\r?\n|\t/g, " ").trim();

  const patterns = [
    /welcome(?: to| aboard)?\s+(.+?)(?:[.!:-]|$)/i,
    /verify (?:your|email for)\s+(.+?)(?:[.!:-]|$)/i,
    /confirm (?:your|the)\s+(.+?) account/i,
    /account (?:created|activated|registered)\s+(?:with )?(.+?)(?:[.!:-]|$)/i,
    /thanks for (?:signing|registering) (?:up|with)\s+(.+?)(?:[.!:-]|$)/i,
    /reset (?:your )?password(?: for)?\s+(.+?)(?:[.!:-]|$)/i,
    /order (?:confirmation|placed|shipped|delivered).*?(-|\s)(.+)/i,
    /security alert.*from\s+(.+?)(?:[.!:-]|$)/i
  ];

  for (const p of patterns) {
    const m = s.match(p);
    if (m && (m[1] || m[2])) {
      return normalizeName(m[1] || m[2]);
    }
  }

  // 🔍 Fallback — keyword-based detection
  const brands = [
    "Netflix", "Amazon", "Spotify", "Instagram", "Facebook", "Zomato",
    "Swiggy", "Snapchat", "Paytm", "Flipkart", "LinkedIn", "Twitter",
    "Google", "YouTube", "Uber", "Meesho", "Blinkit","Firebase","Google Cloud" 
   ];

  for (const b of brands) {
    if (s.toLowerCase().includes(b.toLowerCase())) return b;
  }

  return null;
}


function normalizeName(raw) {
  let r = raw.replace(/["'()]/g, "").trim();
  const map = { insta: "Instagram", fb: "Facebook", msg: "Messenger" };
  for (const k in map) if (r.toLowerCase().includes(k)) return map[k];
  return r
    .split(/\s+/)
    .map((w) => w[0]?.toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

function renderServices(list) {
  const ul = document.getElementById("services");
  if (!ul) return;
  if (list.length === 0) {
    ul.innerHTML = "<li>No services detected</li>";
    return;
  }
  ul.innerHTML = list.map((s) => `<li>${s}</li>`).join("");
}

async function fetchAndShowServices(accessToken, messages) {
  const batchResults = await fetchSubjectsInBatches(accessToken, messages, 8, 250);
  const found = new Set();
  for (const r of batchResults) {
    if (r.ok) {
      const headers = r.json.payload && r.json.payload.headers ? r.json.payload.headers : [];
      const subj = extractSubject(headers);
      console.log("📧 Subject:", subj);
      const svc = detectServiceFromSubject(subj);
      if (svc) found.add(svc);
    } else {
      console.warn("metadata failed", r.id, r.err);
    }
  }
  const arr = Array.from(found);
  console.log("Detected services:", arr);
  renderServices(arr);
}
