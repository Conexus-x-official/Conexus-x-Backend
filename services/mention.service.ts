import WorkspaceMember from "../models/WorkspaceMember";

/**
 * @mentions in an amendment, matched against the workspace roster.
 *
 * There is no mention picker in the composer — it is still a plain textarea
 * (see AGENTS/memory: "@mentions... NOT built"). Rather than build one, this
 * matches on the FIRST NAME only: `@John` in "thanks @John, looks good"
 * captures "John" (letters/digits/'-, stops at whitespace or punctuation) and
 * is matched case-insensitively against active members' first names. Two
 * members sharing a first name both get notified — over-notifying a false
 * positive is a better failure than silently missing the real one, and a
 * proper @-picker (unambiguous by user id) is the real fix if this ever
 * matters enough to build.
 */
const MENTION_PATTERN = /@([A-Za-z][\w'-]{1,29})/g;

export const extractMentionedUserIds = async (
    workspaceId: string,
    text: string,
    excludeUserId: string
): Promise<string[]> => {
    const tokens = [...text.matchAll(MENTION_PATTERN)].map((m) =>
        m[1].toLowerCase()
    );

    if (!tokens.length) return [];

    const members = await WorkspaceMember.find({
        workspace: workspaceId,
        status: "active"
    })
        .populate("user", "firstName")
        .lean();

    const matched = new Set<string>();

    for (const member of members) {
        const user = member.user as unknown as {
            _id?: unknown;
            firstName?: string;
        } | null;

        if (!user?._id || String(user._id) === String(excludeUserId)) continue;

        const firstName = String(user.firstName ?? "").toLowerCase();
        if (firstName && tokens.includes(firstName)) {
            matched.add(String(user._id));
        }
    }

    return [...matched];
};
