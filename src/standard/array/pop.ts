import * as ts from 'typescript';
import { CodeTemplate } from '../../template';
import { StandardCallResolver, IResolver, IResolverMatchOptions } from '../../standard';
import { ArrayType, PointerVarType } from '../../ctypes';
import { IScope } from '../../program';
import { CElementAccess } from '../../nodes/elementaccess';
import { TypeHelper } from '../../typehelper';

@StandardCallResolver
class ArrayPopResolver implements IResolver {
    public matchesNode(typeHelper: TypeHelper, call: ts.CallExpression, options: IResolverMatchOptions) {
        if (call.expression.kind != ts.SyntaxKind.PropertyAccessExpression)
            return false;
        let propAccess = <ts.PropertyAccessExpression>call.expression;
        let objType = typeHelper.getCType(propAccess.expression);
        return propAccess.name.getText() == "pop" && (objType instanceof ArrayType && objType.isDynamicArray || options && options.determineObjectType);
    }
    public objectType(typeHelper: TypeHelper, call: ts.CallExpression) {
        return new ArrayType(PointerVarType, 0, true);
    }
    public returnType(typeHelper: TypeHelper, call: ts.CallExpression) {
        let propAccess = <ts.PropertyAccessExpression>call.expression;
        let objType = <ArrayType>typeHelper.getCType(propAccess.expression);
        return objType.elementType;
    }
    public createTemplate(scope: IScope, node: ts.CallExpression) {
        return new CArrayPop(scope, node);
    }
    public needsDisposal(typeHelper: TypeHelper, node: ts.CallExpression) {
        return false;
    }
    public getTempVarName(typeHelper: TypeHelper, node: ts.CallExpression) {
        return null;
    }
    public getEscapeNode(typeHelper: TypeHelper, node: ts.CallExpression) {
        return null;
    }
}

@CodeTemplate(`ARRAY_POP({varAccess})`)
class CArrayPop {
    public topExpressionOfStatement: boolean;
    public tempVarName: string = '';
    public varAccess: CElementAccess = null;
    constructor(scope: IScope, call: ts.CallExpression) {
        let propAccess = <ts.PropertyAccessExpression>call.expression;
        this.varAccess = new CElementAccess(scope, propAccess.expression);
        scope.root.headerFlags.array = true;
        scope.root.headerFlags.array_pop = true;
    }

}
