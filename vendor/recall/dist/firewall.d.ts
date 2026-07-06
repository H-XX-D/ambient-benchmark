import type { WriteProposal, ValidationIssue } from "./types.js";
export declare function screenFindings(proposal: WriteProposal): {
    secrets: ValidationIssue[];
    publicData: ValidationIssue[];
};
export declare function screenSecrets(proposal: WriteProposal): {
    allowed: boolean;
    issues: ValidationIssue[];
};
export declare function attenuateConfidence(proposal: WriteProposal): {
    confidence: number;
    warnings: string[];
    attenuations: string[];
};
