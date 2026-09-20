/**
 * Sanitizes everyone/here mentions so they don't trigger when bridged.
 *
 * @param {string} content
 * @param {boolean} userHasPingPerms
 * @returns {string}
 */
export function sanitizePings(content, userHasPingPerms = false) {
  let res = content;

  if (!userHasPingPerms)
    res = content
      .replaceAll("@everyone", "@\u200beveryone")
      .replaceAll("@here", "@\u200bhere");

  return res;
}
