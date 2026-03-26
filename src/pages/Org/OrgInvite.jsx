import { useState, useEffect } from "react";
import { useAuth } from "../../context/AuthContext";
import { getOrg, getOrgMembers, updateOrg } from "../../firebase/db";
import { QRCodeSVG } from "qrcode.react";

const MAX_MEMBERS = 10;

export default function OrgInvite() {
  const { userData } = useAuth();
  const orgId = userData?.orgId;
  const [org, setOrg] = useState(null);
  const [memberCount, setMemberCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!orgId) return;
    Promise.all([getOrg(orgId), getOrgMembers(orgId)]).then(([o, m]) => {
      setOrg(o);
      setMemberCount(m.length);
      setLoading(false);
    });
  }, [orgId]);

  const inviteUrl = `${window.location.origin}/join/${orgId}`;
  const spotsLeft = MAX_MEMBERS - memberCount;

  function handleCopy() {
    navigator.clipboard.writeText(inviteUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  if (loading) {
    return <div className="flex justify-center py-10"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div></div>;
  }

  return (
    <div className="max-w-md mx-auto">
      <h1 className="text-2xl font-bold text-gray-900 mb-2">Invite Members</h1>
      <p className="text-sm text-gray-500 mb-6">
        {memberCount} of {MAX_MEMBERS} slots used — {spotsLeft} remaining
      </p>

      {spotsLeft <= 0 ? (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 text-center">
          <p className="text-red-700 font-medium">Member limit reached</p>
          <p className="text-red-500 text-sm mt-1">Maximum {MAX_MEMBERS} members per organisation</p>
        </div>
      ) : (
        <>
          {/* QR Code */}
          <div className="bg-white rounded-xl border border-gray-200 p-6 text-center mb-4">
            <p className="text-sm text-gray-500 mb-4">Share this QR code or link to invite members</p>
            <QRCodeSVG value={inviteUrl} size={180} className="mx-auto mb-4" />
            <p className="text-xs text-gray-400 break-all mb-4">{inviteUrl}</p>
            <button
              onClick={handleCopy}
              className={`w-full py-2.5 rounded-lg text-sm font-medium transition-colors ${
                copied
                  ? "bg-green-100 text-green-700"
                  : "bg-blue-600 text-white hover:bg-blue-700"
              }`}
            >
              {copied ? "Copied!" : "Copy Invite Link"}
            </button>
          </div>

          {/* How it works */}
          <div className="bg-gray-50 rounded-xl p-4">
            <p className="text-xs font-medium text-gray-500 mb-2">How it works</p>
            <ol className="text-xs text-gray-600 space-y-1.5">
              <li>1. Share the link or QR with the person</li>
              <li>2. They create an account (or sign in with Google)</li>
              <li>3. They're automatically added to <strong>{org?.name || orgId}</strong></li>
              <li>4. They can see all org devices on their dashboard</li>
            </ol>
          </div>
        </>
      )}

      {/* Member count bar */}
      <div className="mt-4">
        <div className="flex justify-between text-xs text-gray-500 mb-1">
          <span>Members</span>
          <span>{memberCount}/{MAX_MEMBERS}</span>
        </div>
        <div className="bg-gray-200 rounded-full h-2">
          <div
            className={`h-2 rounded-full transition-all ${
              memberCount >= MAX_MEMBERS ? "bg-red-500" : memberCount >= 8 ? "bg-yellow-500" : "bg-blue-500"
            }`}
            style={{ width: `${(memberCount / MAX_MEMBERS) * 100}%` }}
          />
        </div>
      </div>
    </div>
  );
}
