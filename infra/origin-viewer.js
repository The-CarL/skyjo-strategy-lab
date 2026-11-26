function handler(event) {
  var request = event.request;
  var key = 'x-skyjo-viewer-ip';
  delete request.headers[key];
  if (request.uri === '/api' || request.uri.indexOf('/api/') === 0) {
    request.headers[key] = { value: event.viewer.ip };
  }
  return request;
}
