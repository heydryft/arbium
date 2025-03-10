function arrayDeepEquals(array1, array2, eq) {
    if (array1.length !== array2.length) {
        return false;
    }
    return array1.reduce((prev, current, index) => {
        const other = array2[index];
        if (other == null) {
            return false;
        }
        return prev && eq(current, other);
    }, true);
}

const instructionEquals = (ix1, ix2) => {
    return (
        ix1.programId.equals(ix2.programId) &&
        arrayDeepEquals(
            ix1.keys,
            ix2.keys,
            (a, b) =>
                a.isSigner === b.isSigner &&
                a.isWritable === b.isWritable &&
                a.pubkey.equals(b.pubkey)
        ) &&
        arrayDeepEquals(
            Array.from(ix1.data),
            Array.from(ix2.data),
            (a, b) => a === b
        )
    );
};

export { instructionEquals, arrayDeepEquals };
