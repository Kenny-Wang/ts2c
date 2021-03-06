import * as ts from 'typescript';

import { StandardCallHelper } from './standard';
import { isEqualsExpression, isNullOrUndefinedOrNaN, isFieldPropertyAccess, isFieldElementAccess, isMethodCall, isLiteral, isFunctionArgInMethodCall, isForOfWithSimpleInitializer, isForOfWithIdentifierInitializer, isDeleteExpression, isThisKeyword, isCompoundAssignment, isNumberOp, isIntegerOp, isUnaryExpression, isRelationalOp, isEqualityOp, isStringLiteralAsIdentifier, isLogicOp, isFunction, getUnaryExprResultType, getBinExprResultType, operandsToNumber, toNumberCanBeNaN, findParentFunction, isUnder, findParentSourceFile, getAllNodesUnder } from './utils';
import { CType, NumberVarType, BooleanVarType, StringVarType, RegexVarType, ArrayType, StructType, DictType, FuncType, PointerVarType, UniversalVarType, VoidType, getTypeBodyText } from './ctypes';

type NodeFunc<T extends ts.Node> = { (n: T): ts.Node };
type NodeResolver<T extends ts.Node> = { getNode?: NodeFunc<T>, getType?: { (n: T): CType } };
type Equality<T extends ts.Node> = [{ (n): n is T }, NodeFunc<T>, NodeResolver<T>];

export class TypeHelper {

    private arrayLiteralsTypes: { [litArrayPos: number]: CType } = {};
    private objectLiteralsTypes: { [litObjectPos: number]: CType } = {};
    private typeOfNodeDict: { [id: string]: { node: ts.Node, type: CType } } = {};

    constructor(private typeChecker: ts.TypeChecker, private allNodes: ts.Node[]) { }

    /** Get C type of TypeScript node */
    public getCType(node: ts.Node): CType {
        if (!node || !node.kind)
            return null;

        let found = this.typeOfNodeDict[node.pos + "_" + node.end];
        if (found)
            return found.type;

        switch (node.kind) {
            case ts.SyntaxKind.NumericLiteral:
                return NumberVarType;
            case ts.SyntaxKind.TrueKeyword:
            case ts.SyntaxKind.FalseKeyword:
                return BooleanVarType;
            case ts.SyntaxKind.StringLiteral:
                return StringVarType;
            case ts.SyntaxKind.RegularExpressionLiteral:
                return RegexVarType;
            case ts.SyntaxKind.ArrayLiteralExpression:
                {
                    if (!this.arrayLiteralsTypes[node.pos])
                        this.determineArrayType(<ts.ArrayLiteralExpression>node);
                    return this.arrayLiteralsTypes[node.pos];
                }
            case ts.SyntaxKind.ObjectLiteralExpression:
                {
                    if (!this.objectLiteralsTypes[node.pos])
                        this.objectLiteralsTypes[node.pos] = this.generateStructure(this.typeChecker.getTypeAtLocation(node));
                    return this.objectLiteralsTypes[node.pos];
                }
            case ts.SyntaxKind.CallExpression:
                {
                    let call = <ts.CallExpression>node;
                    let retType = StandardCallHelper.getReturnType(this, call);
                    if (retType)
                        return retType;
                }
        }

        if (node.kind != ts.SyntaxKind.ImportClause && node.pos != -1) {
            let tsType = this.typeChecker.getTypeAtLocation(node);
            let type = tsType && this.convertType(tsType, node);
            if (type)
                return type;
        }

        return null;
    }

    /** Get textual representation of type of the parameter for inserting into the C code */
    public getTypeString(source) {

        let cType = source;
        if (source && source.flags != null && source.intrinsicName != null) // ts.Type
            cType = this.convertType(source)
        else if (source && source.flags != null && source.callSignatures != null && source.constructSignatures != null) // ts.Type
            cType = this.convertType(source)
        else if (source && source.kind != null && source.flags != null) // ts.Node
            cType = this.getCType(source);

        if (cType instanceof ArrayType || cType instanceof StructType || cType instanceof DictType || cType instanceof FuncType)
            return cType.getText();
        else if (typeof cType === 'string')
            return cType;
        else
            return "/* Cannot determine variable type from source " + (source && source.getText ? source.getText() : JSON.stringify(source)) + "*/";
    }

    /** Postprocess TypeScript AST for better type inference and map TS types to C types */
    /** Creates typeOfNodeDict that is later used in getCType */
    public inferTypes() {

        const type = <T extends ts.Node>(t: { (n: T): CType } | string): NodeResolver<T> => ({ getType: typeof (t) === "string" ? _ => t : t });
        const struct = (prop: string, pos: number, elemType: CType = PointerVarType): StructType => new StructType({ [prop]: { type: elemType, order: pos } });

        let typeEqualities: Equality<any>[] = [];

        const addEquality = <T extends ts.Node>(typeGuard: { (n): n is T }, node1: NodeFunc<T>, node2: NodeFunc<T> | NodeResolver<T>) => {
            if (typeof node2 == "function")
                typeEqualities.push([typeGuard, node1, { getNode: node2 }]);
            else
                typeEqualities.push([typeGuard, node1, node2]);
        };

        // left hand side
        addEquality(ts.isIdentifier, n => n, n => this.getDeclaration(n));
        addEquality(ts.isPropertyAssignment, n => n, n => n.initializer);
        addEquality(ts.isPropertyAssignment, n => n.parent, type(n => {
            const propName = (ts.isIdentifier(n.name) || isStringLiteralAsIdentifier(n.name)) && n.name.text;
            if (propName)
                return struct(propName, n.pos, this.getCType(n) || PointerVarType)
            else
                return new DictType(this.getCType(n));
        }));
        addEquality(ts.isPropertyAssignment, n => n, type(n => {
            const propName = (ts.isIdentifier(n.name) || isStringLiteralAsIdentifier(n.name)) && n.name.text;
            const type = this.getCType(n.parent);
            return type instanceof StructType ? type.properties[propName]
                : type instanceof DictType ? type.elementType
                : null;
        }));
        addEquality(ts.isPropertyAssignment, n => n, type(n => {
            const type = this.getCType(n.initializer);
            if (type instanceof FuncType && type.closureParams.length)
                return new FuncType(type.returnType, type.parameterTypes, type.instanceType, type.closureParams, true);
            else
                return null;
        }))
        addEquality(ts.isPropertyAccessExpression, n => n, n => n.name);
        addEquality(isFieldPropertyAccess, n => n.expression, type(n => struct(n.name.getText(), n.pos, this.getCType(n) || PointerVarType)));
        addEquality(isFieldPropertyAccess, n => n, type(n => {
            const type = this.getCType(n.expression);
            return type instanceof StructType ? type.properties[n.name.getText()]
                : type instanceof ArrayType && n.name.getText() == "length" ? NumberVarType
                : type === StringVarType && n.name.getText() == "length" ? NumberVarType
                : type instanceof ArrayType || type instanceof DictType ? type.elementType
                : type === UniversalVarType && n.name.getText() == "length" ? NumberVarType
                : type === UniversalVarType ? UniversalVarType
                : null;
        }));
        addEquality(isFieldElementAccess, n => n.expression, type(n => {
            const type = this.getCType(n.argumentExpression);
            const elementType = this.getCType(n) || PointerVarType;
            return isStringLiteralAsIdentifier(n.argumentExpression) ? struct(n.argumentExpression.text, n.pos, elementType)
                : ts.isNumericLiteral(n.argumentExpression) ? new ArrayType(elementType, 0, false)
                : type == NumberVarType ? new ArrayType(elementType, 0, false)
                : type == StringVarType ? new DictType(elementType)
                : null
        }));
        addEquality(isFieldElementAccess, n => n, type(n => {
            const type = this.getCType(n.expression);
            return ts.isStringLiteral(n.argumentExpression) && type instanceof StructType ? type.properties[n.argumentExpression.getText().slice(1, -1)]
                : ts.isStringLiteral(n.argumentExpression) && type instanceof ArrayType && n.argumentExpression.getText().slice(1, -1) == "length" ? NumberVarType
                : ts.isStringLiteral(n.argumentExpression) && type === StringVarType && n.argumentExpression.getText().slice(1, -1) == "length" ? NumberVarType
                : ts.isStringLiteral(n.argumentExpression) && type === UniversalVarType && n.argumentExpression.getText().slice(1, -1) == "length" ? NumberVarType
                : type instanceof ArrayType || type instanceof DictType ? type.elementType
                : type === UniversalVarType ? UniversalVarType
                : null
        }));
        for (let i = 0; i < 10; i++) {
            addEquality(ts.isArrayLiteralExpression, n => n, type(n => {
                const elemType = this.getCType(n.elements[i]);
                return elemType ? new ArrayType(elemType, 0, false) : null
            }));
            addEquality(ts.isArrayLiteralExpression, n => n.elements[i], type(n => {
                const arrType = this.getCType(n);
                return arrType && arrType instanceof ArrayType ? arrType.elementType
                    : arrType === UniversalVarType ? UniversalVarType
                    : null
            }));
        }

        // expressions
        addEquality(isEqualsExpression, n => n.left, n => n.right);
        addEquality(isEqualsExpression, n => n.left, type(n => {
            const type = this.getCType(n.right);
            if (type instanceof FuncType && type.closureParams.length)
                return new FuncType(type.returnType, type.parameterTypes, type.instanceType, type.closureParams, true);
            else
                return null;
        }));
        addEquality(ts.isConditionalExpression, n => n.whenTrue, n => n.whenFalse);
        addEquality(ts.isConditionalExpression, n => n, n => n.whenTrue);
        addEquality(isUnaryExpression, n => n, type(n => getUnaryExprResultType(n.operator, this.getCType(n.operand))));
        addEquality(isUnaryExpression, n => n.operand, type(n => {
            const resultType = this.getCType(n);
            if (resultType == UniversalVarType && (n.operator === ts.SyntaxKind.PlusPlusToken || n.operator === ts.SyntaxKind.MinusMinusToken))
                return UniversalVarType;
            else
                return null;
        }));
        addEquality(ts.isBinaryExpression, n => n, type(n => getBinExprResultType(this.mergeTypes.bind(this), this.getCType(n.left), n.operatorToken.kind, this.getCType(n.right))));
        addEquality(ts.isBinaryExpression, n => n.left, type(n => {
            const resultType = this.getCType(n);
            const operandType = this.getCType(n.left);
            const rightType = this.getCType(n.right);
            if (resultType === UniversalVarType) {
                return isCompoundAssignment(n.operatorToken) ? UniversalVarType
                    : operandType instanceof ArrayType ? new ArrayType(UniversalVarType, 0, true)
                    : operandType instanceof StructType || operandType instanceof DictType ? new DictType(UniversalVarType)
                    : null;
            } else if (operandsToNumber(operandType, n.operatorToken.kind, rightType) && toNumberCanBeNaN(operandType))
                return UniversalVarType;
            else
                return null;
        }));
        addEquality(ts.isBinaryExpression, n => n.right, type(n => {
            const resultType = this.getCType(n);
            const operandType = this.getCType(n.right);
            const leftType = this.getCType(n.left);
            if (resultType === UniversalVarType && !isLogicOp(n.operatorToken.kind)) {
                return operandType instanceof ArrayType ? new ArrayType(UniversalVarType, 0, true)
                    : operandType instanceof StructType || operandType instanceof DictType ? new DictType(UniversalVarType)
                    : null;
            } else if (operandsToNumber(leftType, n.operatorToken.kind, operandType) && toNumberCanBeNaN(operandType))
                return UniversalVarType;
            else
                return null;
        }));
        addEquality(isNullOrUndefinedOrNaN, n => n, type(UniversalVarType));
        addEquality(ts.isParenthesizedExpression, n => n, n => n.expression);
        addEquality(ts.isVoidExpression, n => n, type(UniversalVarType));
        addEquality(ts.isVoidExpression, n => n.expression, type(PointerVarType));
        addEquality(ts.isTypeOfExpression, n => n, type(StringVarType));
        addEquality(isDeleteExpression, n => n, type(BooleanVarType));
        addEquality(isDeleteExpression, n => n.expression.expression, type(n => new DictType(UniversalVarType)));
    
        // functions
        addEquality(ts.isCallExpression, n => n.expression, n => this.getDeclaration(n));
        addEquality(ts.isCallExpression, n => n.expression, type(n => this.getCType(n) ? new FuncType(this.getCType(n), n.arguments.map(arg => this.getCType(arg))) : null));
        addEquality(ts.isCallExpression, n => n, type(n => FuncType.getReturnType(this, n.expression)));
        addEquality(ts.isParameter, n => n, n => n.name);
        addEquality(ts.isParameter, n => n, n => n.initializer);

        addEquality(ts.isNewExpression, n => n, type(n => 
            ts.isIdentifier(n.expression) && n.expression.text === "Object" ? new StructType({})
            : FuncType.getInstanceType(this, n.expression)
        ));
        for (let i = 0; i < 10; i++)
            addEquality(ts.isNewExpression, n => n.arguments[i], n => {
                const func = this.getDeclaration(n.expression);
                return func && ts.isFunctionDeclaration(func) ? func.parameters[i] : null
            });
        addEquality(isThisKeyword, n => findParentFunction(n), type(n => new FuncType(VoidType, [], this.getCType(n))));
        addEquality(isThisKeyword, n => n, type(n => FuncType.getInstanceType(this, findParentFunction(n))));
    
        addEquality(isMethodCall, n => n.expression.expression, type(n => StandardCallHelper.getObjectType(this, n)));
        addEquality(ts.isCallExpression, n => n, type(n => StandardCallHelper.getReturnType(this, n)));
        for (let i = 0; i < 10; i++)
            addEquality(ts.isCallExpression, n => n.arguments[i], type(n => isLiteral(n.arguments[i]) ? null : StandardCallHelper.getArgumentTypes(this, n)[i]));
            
        // crutch for callback argument type in foreach
        addEquality(isFunctionArgInMethodCall, n => n.parameters[0], type(n => {
            const objType = this.getCType(n.parent.expression.expression);
            return objType instanceof ArrayType && n.parent.expression.name.text == "forEach" ? objType.elementType : null;
        }));

        addEquality(isFunction, n => n, type(n => new FuncType(VoidType, n.parameters.map(p => this.getCType(p)))));
        addEquality(isFunction, n => n, type(node => {
            if (!findParentFunction(node.parent))
                return null;
            const nodesInFunction = getAllNodesUnder(node);
            const closureParams = [];
            nodesInFunction.filter(n => ts.isIdentifier(n))
                .forEach((ident: ts.Identifier) => {
                    const identDecl = this.getDeclaration(ident);
                    if (identDecl && isFunction(identDecl) && !isUnder(node, identDecl)) {
                        const identDeclType = this.getCType(identDecl) as FuncType;
                        for (let param of identDeclType.closureParams) {
                            if (!closureParams.some(p => p.node.text === param.node.text))
                                closureParams.push(param);
                        }
                    } else {
                        const identDeclFunc = identDecl && findParentFunction(identDecl);
                        const isFieldName = ts.isPropertyAccessExpression(ident.parent) && ident.parent.name === ident;
                        const assigned = isEqualsExpression(ident.parent) || isCompoundAssignment(ident.parent);
                        if (identDeclFunc && identDeclFunc != node && isUnder(identDeclFunc, node) && !isFieldName) {
                            const existing = closureParams.filter(p => p.node.escapedText === ident.escapedText)[0];
                            if (!existing)
                                closureParams.push({ assigned, node: ident, refs: [ident] });
                            else if (assigned && !existing.assigned)
                                existing.assigned = true;
                            
                            if (existing)
                                existing.refs.push(ident);
                        }
                    }
                });

            return new FuncType(VoidType, [], null, closureParams);

        }));
        for (let i = 0; i < 10; i++)
            addEquality(isFunction, n => n.parameters[i], type(n => {
                const type = this.getCType(n);
                return type instanceof FuncType ? type.parameterTypes[i] : null
            }));

        // statements
        addEquality(ts.isVariableDeclaration, n => n, n => n.initializer);
        addEquality(ts.isVariableDeclaration, n => n, type(n => {
            const type = this.getCType(n.initializer);
            if (type instanceof FuncType && type.closureParams.length)
                return new FuncType(type.returnType, type.parameterTypes, type.instanceType, type.closureParams, true);
            else
                return null;
        }))
        addEquality(isForOfWithSimpleInitializer, n => n.expression, type(n => new ArrayType(this.getCType(n.initializer.declarations[0]) || PointerVarType, 0, false)));
        addEquality(isForOfWithSimpleInitializer, n => n.initializer.declarations[0], type(n => {
            const type = this.getCType(n.expression);
            return type instanceof ArrayType ? type.elementType : null
        }));
        addEquality(isForOfWithIdentifierInitializer, n => n.expression, type(n => new ArrayType(this.getCType(n.initializer) || PointerVarType, 0, false)));
        addEquality(isForOfWithIdentifierInitializer, n => n.initializer, type(n => {
            const type = this.getCType(n.expression);
            return type instanceof ArrayType ? type.elementType : null
        }));
        addEquality(ts.isForInStatement, n => n.initializer, type(StringVarType));
        addEquality(ts.isForInStatement, n => n.expression, type(n => new DictType(PointerVarType)));
        addEquality(ts.isReturnStatement, n => n.expression, type(n => FuncType.getReturnType(this, findParentFunction(n))));
        addEquality(ts.isReturnStatement, n => findParentFunction(n), type(n => this.getCType(n.expression) ? new FuncType(this.getCType(n.expression)) : null));
        addEquality(ts.isCaseClause, n => n.expression, n => n.parent.parent.expression);
        addEquality(ts.isCatchClause, n => n.variableDeclaration, type(StringVarType));

        this.resolveTypes(typeEqualities);
    }

    private resolveTypes(typeEqualities: Equality<any>[]) {
        this.allNodes.forEach(n => this.setNodeType(n, this.getCType(n)))

        let equalities: [ts.Node, Equality<any>][] = [];
        typeEqualities.forEach(teq =>
            this.allNodes.forEach(node => { if (teq[0].bind(this)(node)) equalities.push([node, teq]); })
        );

        let changed;
        do {
            changed = false;
            for (let equality of equalities) {
                let [node, [_, node1_func, node2_resolver]] = equality;
                let node1 = node1_func(node);
                if (!node1)
                    continue;

                let type1 = this.getCType(node1);

                let node2 = node2_resolver.getNode ? node2_resolver.getNode(node) : null;
                let type2 = node2_resolver.getType ? node2_resolver.getType(node) : this.getCType(node2);
                if (!node2 && !type2)
                    continue;

                let { type, replaced } = this.mergeTypes(type1, type2);
                if (type && replaced) {
                    if (type != type1)
                        changed = true;
                    if (node2 && type != type2)
                        changed = true;
                    this.setNodeType(node1, type);
                    if (node2)
                        this.setNodeType(node2, type);
                }
            }
        } while (changed);

        for (let k in this.typeOfNodeDict) {
            const type = this.typeOfNodeDict[k].type;
            if (type instanceof ArrayType && !type.isDynamicArray && type.capacity == 0)
                type.isDynamicArray = true;
            if (type instanceof StructType && Object.keys(type.properties).length == 0)
                this.typeOfNodeDict[k].type = new DictType(PointerVarType);
        }

        /*
        this.allNodes
            .filter(n => !ts.isToken(n) && !ts.isBlock(n) && n.kind != ts.SyntaxKind.SyntaxList)
            .forEach(n => console.log(n.getText(), "|", ts.SyntaxKind[n.kind], "|", JSON.stringify(this.getCType(n))));
        */

    }

    private static syntheticNodesCounter = 0;
    /** Mostly used inside inferTypes */
    public registerSyntheticNode(n, t) {
        if (!n || !(n.flags & ts.NodeFlags.Synthesized))
            return false;
        
        n.end = TypeHelper.syntheticNodesCounter++;
        this.setNodeType(n, t);
    }

    private setNodeType(n, t) {
        if (n && t)
            this.typeOfNodeDict[n.pos + "_" + n.end] = { node: n, type: t };
    }

    public getDeclaration(n: ts.Node) {
        let s = this.typeChecker.getSymbolAtLocation(n);
        return s && <ts.NamedDeclaration>s.valueDeclaration;
    }
    
    private typesDict = {};
    private ensureNoTypeDuplicates(t) {
        if (!t)
            return null;
        let typeBodyText = getTypeBodyText(t);
        let type = this.typesDict[typeBodyText];
        if (type instanceof ArrayType)
            type.capacity = Math.max(type.capacity, t.capacity);
        if (!type)
            type = this.typesDict[typeBodyText] = t;
        return type;
    }


    /** Convert ts.Type to CType */
    private convertType(tsType: ts.Type, node?: ts.Node): CType {
        if (!tsType || tsType.flags == ts.TypeFlags.Void)
            return VoidType;

        if (tsType.flags == ts.TypeFlags.String || tsType.flags == ts.TypeFlags.StringLiteral)
            return StringVarType;
        if (tsType.flags == ts.TypeFlags.Number || tsType.flags == ts.TypeFlags.NumberLiteral)
            return NumberVarType;
        if (tsType.flags == ts.TypeFlags.Boolean || tsType.flags == (ts.TypeFlags.Boolean + ts.TypeFlags.Union))
            return BooleanVarType;
        if (tsType.flags & ts.TypeFlags.Object && tsType.getProperties().length > 0 && tsType.getProperties().every(s => /[a-zA-Z_]/.test(s.name))) {
            const structType = this.generateStructure(tsType);
            const baseType = this.typeChecker.getBaseTypeOfLiteralType(tsType);
            const cTypeTag = baseType && baseType.symbol && baseType.symbol.getJsDocTags().filter(t => t.name == "ctype")[0];
            structType.forcedType = cTypeTag && cTypeTag.text.trim();
            structType.external = baseType && baseType.symbol && findParentSourceFile(baseType.symbol.declarations[0]).isDeclarationFile;
            return structType;
        }

        return null;
    }

    private generateStructure(tsType: ts.Type): StructType {
        let userStructInfo = {};
        for (let prop of tsType.getProperties()) {
            if (prop.name == "prototype")
                continue;
            let declaration = <ts.NamedDeclaration>prop.valueDeclaration;
            let propTsType = this.typeChecker.getTypeOfSymbolAtLocation(prop, declaration);
            let propType = this.convertType(propTsType, <ts.Identifier>declaration.name) || PointerVarType;
            if (propType == PointerVarType && ts.isPropertyAssignment(declaration)) {
                if (declaration.initializer && ts.isArrayLiteralExpression(declaration.initializer))
                    propType = this.determineArrayType(<ts.ArrayLiteralExpression>declaration.initializer);
            }
            userStructInfo[prop.name] = { type: propType, order: declaration.pos };
        }
        return this.ensureNoTypeDuplicates(new StructType(userStructInfo));
    }

    private determineArrayType(arrLiteral: ts.ArrayLiteralExpression): ArrayType {
        let elementType: CType = PointerVarType;
        let cap = arrLiteral.elements.length;
        if (cap > 0)
            elementType = this.convertType(this.typeChecker.getTypeAtLocation(arrLiteral.elements[0])) || PointerVarType;

        let type = new ArrayType(elementType, cap, false);
        this.arrayLiteralsTypes[arrLiteral.pos] = type;
        return type;
    }

    private mergeTypes(type1: CType, type2: CType): { type: CType, replaced: boolean } {
        let type1_result = { type: this.ensureNoTypeDuplicates(type1), replaced: true };
        let type2_result = { type: this.ensureNoTypeDuplicates(type2), replaced: true };
        let noChanges = { type: this.ensureNoTypeDuplicates(type1), replaced: false };

        if (!type1 && type2)
            return type2_result;
        else if (type1 && !type2)
            return type1_result;
        else if (!type1 && !type2)
            return noChanges;

        else if (typeof type1 == "string" && typeof type2 == "string" && type1 == type2)
            return noChanges;

        else if (type1 === VoidType)
            return type2_result;
        else if (type2 === VoidType)
            return type1_result;

        else if (type1 === PointerVarType)
            return type2_result;
        else if (type2 === PointerVarType)
            return type1_result;

        else if (type1 === UniversalVarType)
            return type1_result;
        else if (type2 === UniversalVarType)
            return type2_result;

        else if (type1 === StringVarType && type2 instanceof StructType) {
            if (Object.keys(type2.properties).length == 1 && (type2.properties["length"] == PointerVarType || type2.properties["length"] == NumberVarType))
                return type1_result;
        }
        else if (type1 instanceof StructType && type2 === StringVarType) {
            if (Object.keys(type1.properties).length == 1 && (type1.properties["length"] == PointerVarType || type1.properties["length"] == NumberVarType))
                return type2_result;
        }
        else if (type1 instanceof ArrayType && type2 instanceof ArrayType) {
            let cap = Math.max(type2.capacity, type1.capacity);
            let isDynamicArray = type2.isDynamicArray || type1.isDynamicArray;
            let elementTypeMergeResult = this.mergeTypes(type1.elementType, type2.elementType);
            if (type1.capacity != cap || type2.capacity != cap
                || type1.isDynamicArray != isDynamicArray || type2.isDynamicArray != isDynamicArray
                || elementTypeMergeResult.replaced)
                return { type: this.ensureNoTypeDuplicates(new ArrayType(elementTypeMergeResult.type, cap, isDynamicArray)), replaced: true };

            return noChanges;
        }
        else if (type1 instanceof DictType && type2 instanceof ArrayType) {
            return type1_result;
        }
        else if (type1 instanceof ArrayType && type2 instanceof DictType) {
            return type2_result;
        }
        else if (type1 instanceof StructType && type2 instanceof StructType) {
            let props = Object.keys(type1.properties).concat(Object.keys(type2.properties));
            let changed = false;
            let newProps = {};
            for (let p of props) {
                let recursive1 = type1.propertyDefs[p] && type1.propertyDefs[p].recursive;
                let recursive2 = type2.propertyDefs[p] && type2.propertyDefs[p].recursive;
                let result;
                if (recursive1 || recursive2)
                    result = { type: recursive1 ? type1 : type2, replaced: recursive1 != recursive2 };
                else
                    result = this.mergeTypes(type1.properties[p], type2.properties[p]);
                let order = Math.max(type1.propertyDefs[p] ? type1.propertyDefs[p].order : 0, type2.propertyDefs[p] ? type2.propertyDefs[p].order : 0);
                newProps[p] = { type: result.type, order: order, recursive: type1 == result.type || type2 == result.type };
                if (result.replaced)
                    changed = true;
            }
            return changed ? { type: this.ensureNoTypeDuplicates(new StructType(newProps)), replaced: true } : noChanges;
        }
        else if (type1 instanceof ArrayType && type2 instanceof StructType) {
            return this.mergeArrayAndStruct(type1, type2);
        }
        else if (type1 instanceof StructType && type2 instanceof ArrayType) {
            return this.mergeArrayAndStruct(type2, type1);
        }
        else if (type1 instanceof DictType && type2 instanceof StructType) {
            return this.mergeDictAndStruct(type1, type2);
        }
        else if (type1 instanceof StructType && type2 instanceof DictType) {
            return this.mergeDictAndStruct(type2, type1)
        }
        else if (type1 instanceof DictType && type2 instanceof DictType) {
            const { type: elemType, replaced } = this.mergeTypes(type1.elementType, type2.elementType);
            if (replaced)
                return { type: this.ensureNoTypeDuplicates(new DictType(elemType)), replaced: true };
            else
                return noChanges;
        }
        else if (type1 instanceof FuncType && type2 instanceof FuncType) {
            const { type: returnType, replaced: returnTypeReplaced } = this.mergeTypes(type1.returnType, type2.returnType);
            const { type: instanceType, replaced: instanceTypeReplaced } = this.mergeTypes(type1.instanceType, type2.instanceType);
            const paramCount = Math.max(type1.parameterTypes.length, type2.parameterTypes.length);
            let paramTypesReplaced = type1.parameterTypes.length !== type2.parameterTypes.length;
            let paramTypes = [];
            for (let i = 0; i < paramCount; i++) {
                const { type: pType, replaced: pTypeReplaced } = this.mergeTypes(type1.parameterTypes[i], type2.parameterTypes[i]);
                paramTypes.push(pType)
                if (pTypeReplaced)
                    paramTypesReplaced = true;
            }
            const closureParamCount = Math.max(type1.closureParams.length, type2.closureParams.length);
            let closureParamsReplaced = type1.closureParams.length !== type2.closureParams.length;
            let closureParams = [];
            for (let i = 0; i < closureParamCount; i++) {
                closureParams.push(type1.closureParams[i] || type2.closureParams[i]);
            }

            if (returnTypeReplaced || instanceTypeReplaced || paramTypesReplaced || closureParamsReplaced || type1.needsClosureStruct != type2.needsClosureStruct)
                return { type: this.ensureNoTypeDuplicates(new FuncType(returnType, paramTypes, instanceType, closureParams, type1.needsClosureStruct || type2.needsClosureStruct)), replaced: true };
            else
                return noChanges;
        }
        else
            return { type: UniversalVarType, replaced: true };
    }

    private mergeArrayAndStruct(arrayType: ArrayType, structType: StructType) {
        let props = Object.keys(structType.properties);
        let needPromoteToDictionary = false;
        let needPromoteToTuple = false;
        for (let p of props) {
            if (p == "length")
                continue;
            if (isNaN(+p))
                needPromoteToDictionary = true;
            if (this.mergeTypes(arrayType.elementType, structType.properties[p]).replaced)
                needPromoteToTuple = true;
        }
        if (needPromoteToDictionary && needPromoteToTuple)
            return { type: this.ensureNoTypeDuplicates(new DictType(UniversalVarType)), replaced: true };
        else if (needPromoteToDictionary)
            return { type: this.ensureNoTypeDuplicates(new DictType(arrayType.elementType)), replaced: true };
        else if (needPromoteToTuple)
            return { type: this.ensureNoTypeDuplicates(new ArrayType(UniversalVarType, arrayType.capacity, arrayType.isDynamicArray)), replaced: true };
        else
            return { type: arrayType, replaced: true };
    }

    private mergeDictAndStruct(dictType: DictType, structType: StructType) {
        let elementType = dictType.elementType;
        for (let k in structType.properties)
            ({ type: elementType } = this.mergeTypes(elementType, structType.properties[k]));
        return { type: this.ensureNoTypeDuplicates(new DictType(elementType)), replaced: true };
    }

}