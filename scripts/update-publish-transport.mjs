/** Desktop feed 与 Source Server 共用的自建 update Worker 发布传输。 */
export function createUpdatePublishTransport({
  endpoint,
  token,
  fetchImpl = fetch,
  attempts = 5,
  retryDelayMs = 2_000,
  multipartThreshold = 90 * 1024 * 1024,
  partSize = 80 * 1024 * 1024,
}) {
  async function fetchWithRetry(url, init, label, maxAttempts = attempts) {
    let lastError;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const response = await fetchImpl(url, init);
        if (response.status < 500) return response;
        lastError = new Error(`${label}: HTTP ${response.status}`);
        await response.body?.cancel();
      } catch (error) {
        lastError = error;
      }
      if (attempt < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs * 2 ** (attempt - 1)));
      }
    }
    throw lastError;
  }

  async function checked(response, label) {
    if (!response.ok) throw new Error(`${label}: HTTP ${response.status} ${await response.text()}`);
    return response;
  }

  async function publishBytes(path, body, contentType, key) {
    if (body.byteLength <= multipartThreshold) {
      await checked(
        await fetchWithRetry(
          `${endpoint}${path}`,
          {
            method: "PUT",
            headers: { "x-publish-token": token, "content-type": contentType },
            body,
          },
          path,
        ),
        path,
      );
      return;
    }
    const init = await checked(
      await fetchWithRetry(
        `${endpoint}/admin/multipart/init`,
        {
          method: "POST",
          headers: {
            "x-publish-token": token,
            "content-type": "application/json",
          },
          body: JSON.stringify({ key, contentType }),
        },
        "multipart init",
      ),
      "multipart init",
    );
    const { uploadId } = await init.json();
    const parts = [];
    for (let offset = 0, number = 1; offset < body.byteLength; offset += partSize, number++) {
      const response = await checked(
        await fetchWithRetry(
          `${endpoint}/admin/multipart/${uploadId}/${number}?key=${encodeURIComponent(key)}`,
          {
            method: "PUT",
            headers: {
              "x-publish-token": token,
              "content-type": "application/octet-stream",
            },
            body: body.subarray(offset, Math.min(offset + partSize, body.byteLength)),
          },
          `multipart part ${number}`,
        ),
        `multipart part ${number}`,
      );
      const { etag } = await response.json();
      parts.push({ etag, partNumber: number });
    }
    await checked(
      await fetchWithRetry(
        `${endpoint}/admin/multipart/complete`,
        {
          method: "POST",
          headers: {
            "x-publish-token": token,
            "content-type": "application/json",
          },
          body: JSON.stringify({ uploadId, key, parts }),
        },
        "multipart complete",
      ),
      "multipart complete",
    );
  }
  return { fetchWithRetry, publishBytes };
}
