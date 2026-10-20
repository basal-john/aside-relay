"""Cloudflare Access JWT 검증.

목적: 브라우저가 Access(구글 로그인)를 이미 통과했다는 사실을 브리지가 **증명 가능하게** 확인해서,
      기기마다 브리지 토큰을 손으로 입력하지 않게 하는 것.

헤더(`cf-access-authenticated-user-email`)만 믿지 않는다. 그 헤더는 오리진에 도달하기 전까지
누가 넣었는지 코드만 보고는 알 수 없다. 대신 같이 오는 `cf-access-jwt-assertion` 을
Cloudflare 의 공개키로 서명 검증한다 — 위조하려면 Cloudflare 개인키가 있어야 한다.

PyJWT 가 없어서 cryptography 로 직접 RS256 을 검증한다.
"""
from __future__ import annotations

import base64
import json
import logging
import math
import time

import httpx
from cryptography.hazmat.primitives.asymmetric import padding, rsa
from cryptography.hazmat.primitives.asymmetric.rsa import RSAPublicNumbers
from cryptography.hazmat.primitives.hashes import SHA256

log = logging.getLogger("aside-relay.cfaccess")

import config

# Team domain comes from config (ASIDE_RELAY_ACCESS_TEAM). Empty = feature off;
# verify() then rejects everything, and only loopback token bootstrap works.
TEAM_DOMAIN = config.ACCESS_TEAM_DOMAIN
CERTS_URL = f"https://{TEAM_DOMAIN}/cdn-cgi/access/certs" if TEAM_DOMAIN else ""
ISSUER = f"https://{TEAM_DOMAIN}" if TEAM_DOMAIN else ""
JWKS_TTL = 3600.0

_jwks: dict[str, rsa.RSAPublicKey] = {}
_jwks_at = 0.0


def _b64u(data: str) -> bytes:
    return base64.urlsafe_b64decode(data + "=" * (-len(data) % 4))


def _is_finite_number(value: object) -> bool:
    return (isinstance(value, (int, float)) and not isinstance(value, bool)
            and (not isinstance(value, float) or math.isfinite(value)))


async def _load_jwks(client: httpx.AsyncClient, force: bool = False) -> dict[str, rsa.RSAPublicKey]:
    global _jwks, _jwks_at
    if not CERTS_URL:
        return {}
    if _jwks and not force and time.time() - _jwks_at < JWKS_TTL:
        return _jwks
    r = await client.get(CERTS_URL, timeout=10)
    r.raise_for_status()
    payload = r.json()
    if not isinstance(payload, dict):
        raise ValueError("invalid Access JWKS response")
    jwks = payload.get("keys")
    if not isinstance(jwks, list):
        raise ValueError("invalid Access JWKS response")
    keys: dict[str, rsa.RSAPublicKey] = {}
    for k in jwks:
        if not isinstance(k, dict) or k.get("kty") != "RSA" or not isinstance(k.get("kid"), str):
            continue
        try:
            n = int.from_bytes(_b64u(k["n"]), "big")
            e = int.from_bytes(_b64u(k["e"]), "big")
            keys[k["kid"]] = RSAPublicNumbers(e, n).public_key()
        except (KeyError, TypeError, ValueError):
            continue
    if not keys:
        raise ValueError("Access JWKS contains no usable RSA keys")
    _jwks, _jwks_at = keys, time.time()
    return _jwks


async def verify(client: httpx.AsyncClient, token: str, *, aud: str,
                 allowed_emails: set[str], allowed_cns: set[str] | None = None) -> str | None:
    """검증 통과하면 주체(이메일 또는 svc:<common_name>), 아니면 None.

    브라우저 로그인은 email 클레임을, service token 은 common_name 클레임을 준다.
    (실측 payload: {"type":"app","common_name":"<client_id>.access",...} — email 없음)
    """
    try:
        head_b64, payload_b64, sig_b64 = token.split(".")
        header = json.loads(_b64u(head_b64))
        payload = json.loads(_b64u(payload_b64))
    except Exception:
        return None

    if not isinstance(header, dict) or not isinstance(payload, dict):
        return None

    if header.get("alg") != "RS256":
        log.warning("reject: alg=%s", header.get("alg")); return None

    kid = header.get("kid")
    if not isinstance(kid, str) or not kid:
        log.warning("reject: invalid kid"); return None
    keys = await _load_jwks(client)
    key = keys.get(kid)
    if key is None:                       # 키 회전 직후일 수 있다 → 한 번만 강제 갱신
        keys = await _load_jwks(client, force=True)
        key = keys.get(kid)
    if key is None:
        log.warning("reject: kid %s not in jwks %s", kid, list(keys)); return None

    try:
        key.verify(_b64u(sig_b64), f"{head_b64}.{payload_b64}".encode(),
                   padding.PKCS1v15(), SHA256())
    except Exception as exc:
        log.warning("reject: signature %s", exc); return None

    now = time.time()
    exp = payload.get("exp")
    nbf = payload.get("nbf", 0)
    if not _is_finite_number(exp) or exp < now - 60:
        log.warning("reject: expired"); return None
    if not _is_finite_number(nbf) or nbf > now + 60:
        log.warning("reject: nbf"); return None
    if payload.get("iss") != ISSUER:
        log.warning("reject: iss=%s expected=%s", payload.get("iss"), ISSUER); return None
    claim_aud = payload.get("aud")
    auds = claim_aud if isinstance(claim_aud, list) else [claim_aud]
    if aud not in auds:
        log.warning("reject: aud=%s expected=%s", auds, aud); return None
    claim_email = payload.get("email", "")
    if not isinstance(claim_email, str):
        log.warning("reject: invalid email claim"); return None
    email = claim_email.lower()
    if email:
        if email not in allowed_emails:
            log.warning("reject: email=%r", email); return None
        return email
    claim_cn = payload.get("common_name", "")
    if not isinstance(claim_cn, str):
        log.warning("reject: invalid common_name claim"); return None
    cn = claim_cn.strip()
    if cn and allowed_cns and cn in allowed_cns:
        return f"svc:{cn}"
    log.warning("reject: no allowed principal (cn=%r, keys=%s)", cn, list(payload))
    return None
