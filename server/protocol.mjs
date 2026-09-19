// The structural boundary every inbound socket frame crosses. JSON.parse accepts
// more than our protocol does — null, a bare number, a string, an array are all
// valid JSON — and the routers downstream read frame.kind straight away, so a
// literal `null` on the wire used to throw out of the message handler. A frame is
// only ours if it is a plain object carrying a string kind; anything else is
// dropped at the edge rather than reaching a handler.
export function isFrame(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) && typeof value.kind === "string";
}
