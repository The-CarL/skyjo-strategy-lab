import { createServer } from 'node:http'
import { createHandler } from '../online-dist/lambda/index.mjs'
import { createMemoryStore } from '../server/store.mjs'

const host = '127.0.0.1'
const port = Number(process.env.PORT || 4175)
const api = createHandler(createMemoryStore())
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://' + host)
    const chunks = []
    let size = 0
    for await (const chunk of req) {
      size += chunk.length
      if (size > 32768) {
        res.writeHead(413).end()
        return
      }
      chunks.push(chunk)
    }
    const result = await api({
      version: '2.0', rawPath: url.pathname, rawQueryString: url.search.slice(1),
      queryStringParameters: Object.fromEntries(url.searchParams), headers: req.headers,
      requestContext: { http: { method: req.method, path: url.pathname } },
      body: chunks.length ? Buffer.concat(chunks).toString('utf8') : undefined,
      isBase64Encoded: false,
    })
    res.writeHead(result.statusCode, result.headers)
    res.end(result.isBase64Encoded ? Buffer.from(result.body, 'base64') : result.body)
  } catch {
    res.writeHead(500, { 'content-type': 'text/plain' }).end('Game service error')
  }
})
server.listen(port, host, () => console.log('Local Skyjo table (in-memory history): http://' + host + ':' + port))
