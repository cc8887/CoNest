/** Read the scripted model's JSON input at the actual HTTP stream boundary. */
export async function readModelRequest(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}
