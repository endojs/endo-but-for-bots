package org.endo.floot;

/** One-shot handoff from the system-bound session service, not arbitrary app intents. */
final class AssistantInvocation {
    private static String issued;
    static synchronized String issue() {
        issued = java.util.UUID.randomUUID().toString();
        return issued;
    }
    static synchronized String take(String candidate) {
        if (candidate == null || !candidate.equals(issued)) return null;
        issued = null;
        return candidate;
    }
    private AssistantInvocation() {}
}
