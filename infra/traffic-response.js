function handler(event) {
  var request = event.request;
  var marker = request.headers['x-amzn-waf-skyjo-rate'];
  if (marker && (marker.value === '1' || (marker.multiValue || []).some(function (item) { return item.value === '1'; }))) {
    return {
      statusCode: 429,
      statusDescription: 'Too Many Requests',
      headers: {
        'cache-control': { value: 'no-store' },
        'content-type': { value: 'application/json' },
        'retry-after': { value: '300' }
      },
      body: { encoding: 'text', data: JSON.stringify({error: {
        code: 'rate_limited', message: 'Too many requests from this connection. Please retry in five minutes.'
      }}) }
    };
  }
  return request;
}
